using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

internal static class MulticaAgentLauncher
{
    private const string UserDataPathOverride = null;
    private const int ProtocolVersion = 4;
    private const int MaxFrameBytes = 16 * 1024 * 1024;
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength = MaxFrameBytes }; }

    // Electron's Windows GUI entry closes stdin. Keep stdio in this console
    // process and connect directly to the application's authenticated local pipe.
    private static int Main()
    {
        try
        {
            string name = Path.GetFileNameWithoutExtension(Process.GetCurrentProcess().MainModule.FileName);
            if (!name.EndsWith("-agent", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Agent launcher filename is invalid.");
            string productName = name.Substring(0, name.Length - "-agent".Length);
            string[] arguments = Environment.GetCommandLineArgs().Skip(1).ToArray();
            bool streaming = arguments.SequenceEqual(new[] { "app-server", "--listen", "stdio://" });
            if (!streaming && !arguments.SequenceEqual(new[] { "--version" }) &&
                !arguments.SequenceEqual(new[] { "debug", "models" }) &&
                !arguments.SequenceEqual(new[] { "debug", "models", "--bundled" }))
            {
                Console.Error.WriteLine("Unsupported runtime command. Select the Codex provider in Multica.");
                return 64;
            }
            string userData = UserDataPathOverride ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), productName);
            string metadataPath = Path.Combine(userData, "multica", "bridge.json");
            if (!File.Exists(metadataPath))
            {
                Console.Error.WriteLine(productName + " is not running. Start it and keep it open or in the tray.");
                return 69;
            }
            if (new FileInfo(metadataPath).Length > 4096)
                throw new InvalidDataException("Bridge metadata is invalid. Restart " + productName + ".");
            var metadata = Json().Deserialize<Dictionary<string, object>>(File.ReadAllText(metadataPath, Utf8));
            string endpoint = StringField(metadata, "endpoint");
            string token = StringField(metadata, "token");
            object version, pid;
            if (metadata == null || !metadata.TryGetValue("version", out version) ||
                !metadata.TryGetValue("pid", out pid) || !(version is int) || (int)version != ProtocolVersion ||
                !(pid is int) || (int)pid <= 0 || String.IsNullOrEmpty(token) ||
                !Regex.IsMatch(endpoint ?? "", @"^\\\\\.\\pipe\\justdo-multica-[0-9a-f]{20}$"))
                throw new InvalidDataException("Restart " + productName + " to refresh its Multica bridge.");

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
                        { "env", EnvironmentForBridge() }
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
                            Console.Error.WriteLine("The application bridge disconnected before completion.");
                            return 70;
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
                            Console.Error.WriteLine(StringField(response, "message") ?? "Bridge request failed.");
                            return 70;
                        }
                        else throw new InvalidDataException("Invalid bridge response.");
                    }
                }
            }
        }
        catch (TimeoutException) { Console.Error.WriteLine("The application bridge is unavailable. Restart the application."); return 69; }
        catch (Exception error) { Console.Error.WriteLine("Agent launcher failed: " + error.Message); return 70; }
    }

    private static string StringField(Dictionary<string, object> value, string key)
    {
        object field;
        return value != null && value.TryGetValue(key, out field) ? field as string : null;
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

    private static Dictionary<string, string> EnvironmentForBridge()
    {
        var blocked = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            "ELECTRON_RUN_AS_NODE", "NODE_ENV", "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH",
            "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "OPENCLAW_STATE_DIR", "OPENCLAW_HOME",
            "OPENCLAW_GATEWAY_URL", "OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD", "OPENCLAW_GATEWAY_PORT"
        };
        var result = new Dictionary<string, string>();
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            string name = (string)entry.Key, value = (string)entry.Value;
            string upper = name.ToUpperInvariant();
            if (Regex.IsMatch(name, @"^[A-Za-z_][A-Za-z0-9_]{0,127}$") && !blocked.Contains(name) &&
                !upper.StartsWith("JUSTDO_") && !upper.StartsWith("ELECTRON_") && !upper.StartsWith("OPENCLAW_BUNDLED_") &&
                !String.IsNullOrEmpty(value) && value.IndexOf('\0') < 0) result[name] = value;
        }
        return result;
    }
}
