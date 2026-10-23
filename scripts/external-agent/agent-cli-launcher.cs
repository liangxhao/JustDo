using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

internal static class AgentCliLauncher
{
    private const string UserDataPathOverride = null;
    private const string ProductDisplayName = null;
    private const string ApplicationVersion = null;
    private const string HelpEnglish = null;
    private const string HelpChinese = null;
    private const int ProtocolVersion = 4;
    private const int MaxFrameBytes = 16 * 1024 * 1024;
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength = MaxFrameBytes }; }
    private static bool MachineOutput;
    private static string Localized(string english, string chinese)
    {
        return CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "zh" ? chinese : english;
    }

    // Electron's Windows GUI entry closes stdin. Keep stdio in this console
    // process and connect directly to the application's authenticated local pipe.
    private static int Main()
    {
        string[] arguments = Environment.GetCommandLineArgs().Skip(1).ToArray();
        MachineOutput = UsesMachineOutput(arguments);
        try
        {
            if (arguments.Length == 0 || (arguments.Length == 1 &&
                (arguments[0] == "help" || arguments[0] == "--help" || arguments[0] == "-h")))
            {
                WriteLocalOutput(false, Localized(HelpEnglish, HelpChinese));
                return 0;
            }
            if (arguments.Length == 1 && (arguments[0] == "--version" || arguments[0] == "-V"))
            {
                WriteLocalOutput(false, ProductDisplayName + " " + ApplicationVersion + "\n");
                return 0;
            }
            bool codex = arguments.SequenceEqual(new[] { "app-server", "--listen", "stdio://" });
            bool codexModels = arguments.SequenceEqual(new[] { "debug", "models" }) ||
                arguments.SequenceEqual(new[] { "debug", "models", "--bundled" });
            bool acp = arguments.SequenceEqual(new[] { "acp" });
            bool streaming = codex || acp;
            // Main owns full option validation. This only admits known command
            // families before reading credentials or connecting to the pipe.
            bool generic = codex || codexModels || acp || arguments[0] == "status" || arguments[0] == "exec" ||
                (arguments.Length >= 2 && arguments[0] == "models" && arguments[1] == "list");
            if (!generic)
                return Fail(64, "INVALID_ARGUMENTS", Localized(
                    "Unsupported command. Use --help for the agent CLI commands.",
                    "不支持此命令，请使用 --help 查看命令行帮助。"));
            string userData = UserDataPathOverride ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), ProductDisplayName);
            string metadataPath = Path.Combine(userData, "external-agent", "bridge.json");
            if (!File.Exists(metadataPath))
            {
                return Fail(69, "HOST_UNAVAILABLE", Localized(
                    ProductDisplayName + " is not running. Start it and keep it open or in the tray.",
                    ProductDisplayName + " 未运行，请启动应用并保持打开，也可最小化到托盘。"));
            }
            if (new FileInfo(metadataPath).Length > 4096)
                throw new InvalidDataException(Localized("Bridge metadata is invalid. Restart the application.", "后台连接信息无效，请重启应用。"));
            var metadata = Json().Deserialize<Dictionary<string, object>>(File.ReadAllText(metadataPath, Utf8));
            string endpoint = StringField(metadata, "endpoint");
            string token = StringField(metadata, "token");
            object version, pid;
            if (metadata == null || !metadata.TryGetValue("version", out version) ||
                !metadata.TryGetValue("pid", out pid) || !(version is int) || (int)version != ProtocolVersion ||
                !(pid is int) || (int)pid <= 0 || String.IsNullOrEmpty(token) ||
                !Regex.IsMatch(endpoint ?? "", @"^\\\\\.\\pipe\\external-agent-[0-9a-f]{20}$"))
                throw new InvalidDataException(Localized("Restart the application to refresh its local bridge.", "请重启应用以刷新本机后台连接。"));

            if (IsHostDefinitelyStopped((int)pid))
                return Fail(69, "HOST_UNAVAILABLE", Localized(
                    ProductDisplayName + " is not running. Start it and keep it open or in the tray.",
                    ProductDisplayName + " 未运行，请启动应用并保持打开，也可最小化到托盘。"));

            // Overlapped mode allows the input pump to write while the main
            // thread awaits replies. A synchronous duplex handle deadlocks here.
            using (var pipe = new NamedPipeClientStream(".", endpoint.Substring(@"\\.\pipe\".Length), PipeDirection.InOut, PipeOptions.Asynchronous))
            {
                pipe.Connect(5000);
                Console.CancelKeyPress += (sender, args) => { args.Cancel = true; pipe.Dispose(); };
                using (var writer = new StreamWriter(pipe, Utf8, 4096, true) { AutoFlush = true })
                using (var reader = new StreamReader(pipe, Utf8, false, 4096, true))
                {
                    WriteFrame(writer, new Dictionary<string, object> {
                        { "type", "request" }, { "version", ProtocolVersion },
                        { "requestId", Guid.NewGuid().ToString() }, { "token", token },
                        { "argv", arguments }, { "cwd", Environment.CurrentDirectory },
                        { "env", codex ? CodexEnvironmentForBridge() : new Dictionary<string, string>() }
                    });
                    int inputEnded = 0;
                    if (streaming)
                    {
                        var inputThread = new Thread(() => {
                            try
                            {
                                using (var input = Console.OpenStandardInput())
                                {
                                    byte[] chunk = new byte[4096];
                                    char[] characters = new char[4098];
                                    Decoder decoder = Utf8.GetDecoder();
                                    int count;
                                    while ((count = input.Read(chunk, 0, chunk.Length)) > 0)
                                    {
                                        int decoded = decoder.GetChars(chunk, 0, count, characters, 0, false);
                                        if (decoded > 0)
                                            WriteFrame(writer, new Dictionary<string, object> { { "type", "stdin" }, { "data", new string(characters, 0, decoded) } });
                                    }
                                    decoder.GetChars(chunk, 0, 0, characters, 0, true);
                                    Interlocked.Exchange(ref inputEnded, 1);
                                    WriteFrame(writer, new Dictionary<string, object> { { "type", "eof" } });
                                }
                            }
                            catch { pipe.Dispose(); }
                        });
                        inputThread.IsBackground = true;
                        inputThread.Start();
                    }
                    for (;;)
                    {
                        string line = ReadFrame(reader);
                        if (line == null)
                        {
                            if (streaming && Volatile.Read(ref inputEnded) == 1) return 0;
                            return Fail(70, "BRIDGE_ERROR", Localized(
                                "The application bridge disconnected before completion. Execution outcome is unknown.",
                                "应用后台连接在完成前断开，执行结果尚未确认。"));
                        }
                        var response = Json().Deserialize<Dictionary<string, object>>(line);
                        string type = StringField(response, "type");
                        if (type == "stdout" || type == "stderr")
                        {
                            byte[] bytes = Convert.FromBase64String(StringField(response, "data"));
                            Stream output = type == "stdout" ? Console.OpenStandardOutput() : Console.OpenStandardError();
                            output.Write(bytes, 0, bytes.Length);
                            output.Flush();
                        }
                        else if (type == "exit")
                        {
                            object code;
                            if (!response.TryGetValue("code", out code) || !(code is int))
                                throw new InvalidDataException("Invalid bridge exit response.");
                            return (int)code;
                        }
                        else if (type == "error")
                        {
                            return Fail(70, "BRIDGE_ERROR", StringField(response, "message") ??
                                Localized("Bridge request failed.", "后台请求失败。"));
                        }
                        else throw new InvalidDataException("Invalid bridge response.");
                    }
                }
            }
        }
        catch (TimeoutException) { return Fail(69, "HOST_UNAVAILABLE", Localized("The application bridge is unavailable. Restart the application.", "无法连接应用后台，请重启应用。")); }
        // Deserializer exceptions can quote credentials or task content. Report
        // the transport failure without copying raw exception messages.
        catch (Exception) { return Fail(70, "BRIDGE_ERROR", Localized(
            "The agent CLI could not communicate with the application bridge. Check the desktop application status.",
            "命令行无法与应用后台通信，请检查桌面应用状态。")); }
    }

    private static bool UsesMachineOutput(string[] arguments)
    {
        for (int index = 1; index < arguments.Length; index++)
        {
            string argument = arguments[index];
            if (argument == "--") return false;
            if (argument == "--cwd" || argument == "--session" || argument == "--model" || argument == "--prompt")
            {
                index++;
                continue;
            }
            if (argument == "--json" || argument == "--stream-json") return true;
        }
        return false;
    }

    private static int Fail(int code, string errorCode, string message)
    {
        if (MachineOutput)
            WriteLocalOutput(false, Json().Serialize(new Dictionary<string, object> {
                { "type", "error" }, { "error", new Dictionary<string, string> {
                    { "code", errorCode }, { "message", message }
                } }
            }) + "\n");
        else WriteLocalOutput(true, message + "\n");
        return code;
    }

    private static void WriteLocalOutput(bool error, string value)
    {
        byte[] bytes = Utf8.GetBytes(value);
        Stream output = error ? Console.OpenStandardError() : Console.OpenStandardOutput();
        output.Write(bytes, 0, bytes.Length);
        output.Flush();
    }

    private static string StringField(Dictionary<string, object> value, string key)
    {
        object field;
        return value != null && value.TryGetValue(key, out field) ? field as string : null;
    }

    // Only a confirmed exit denies availability. Permission/probe failures still
    // use the authenticated pipe; the PID is never an authorization credential.
    private static bool IsHostDefinitelyStopped(int pid)
    {
        try
        {
            using (var host = System.Diagnostics.Process.GetProcessById(pid))
                return host.HasExited;
        }
        catch (ArgumentException) { return true; }
        catch (Exception) { return false; }
    }

    private static void WriteFrame(StreamWriter writer, object value)
    {
        string frame = Json().Serialize(value);
        if (Utf8.GetByteCount(frame) > MaxFrameBytes) throw new InvalidDataException("Bridge request is too large.");
        writer.WriteLine(frame);
    }

    private static string ReadFrame(StreamReader reader)
    {
        var line = new StringBuilder();
        int character;
        while ((character = reader.Read()) >= 0)
        {
            if (character == '\n')
            {
                if (Utf8.GetByteCount(line.ToString()) > MaxFrameBytes) throw new InvalidDataException("Bridge response is too large.");
                return line.ToString();
            }
            if (line.Length >= MaxFrameBytes) throw new InvalidDataException("Bridge response is too large.");
            line.Append((char)character);
        }
        if (line.Length != 0) throw new InvalidDataException("Incomplete bridge response.");
        return null;
    }

    private static Dictionary<string, string> CodexEnvironmentForBridge()
    {
        var result = new Dictionary<string, string>();
        string home = Environment.GetEnvironmentVariable("CODEX_HOME");
        if (!String.IsNullOrEmpty(home) && home.Length <= 32768 && home.IndexOf('\0') < 0)
            result["CODEX_HOME"] = home;
        return result;
    }
}
