using Microsoft.Win32;
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

internal static class BrowserExtensionNativeHost
{
    private const string ExtensionOrigin = "chrome-extension://jboajogplelmaahjbomgflnfngpolgcb/";
    private const string HostName = "com.justdo.browserextension";
    private const int MaxMessageBytes = 1024 * 1024;
    private const int ProtocolVersion = 2;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.All(character => !char.IsWhiteSpace(character) && character != '"'))
        {
            return value;
        }
        StringBuilder result = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') backslashes += 1;
            else if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
            }
            else
            {
                result.Append('\\', backslashes);
                result.Append(character);
                backslashes = 0;
            }
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static byte[] ReadExact(Stream input, int length, bool allowEnd)
    {
        byte[] result = new byte[length];
        int offset = 0;
        while (offset < length)
        {
            int count = input.Read(result, offset, length - offset);
            if (count == 0)
            {
                if (allowEnd && offset == 0) return null;
                throw new EndOfStreamException("Native message ended unexpectedly.");
            }
            offset += count;
        }
        return result;
    }

    private static void WriteMessage(Stream output, object value)
    {
        byte[] body = Encoding.UTF8.GetBytes(Json.Serialize(value));
        byte[] header = BitConverter.GetBytes(body.Length);
        output.Write(header, 0, header.Length);
        output.Write(body, 0, body.Length);
        output.Flush();
    }

    private static string ResolveConfigPath()
    {
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(
            @"Software\Google\Chrome\NativeMessagingHosts\" + HostName))
        {
            string manifestPath = key == null ? null : key.GetValue(null) as string;
            if (String.IsNullOrWhiteSpace(manifestPath))
                throw new InvalidOperationException("The native host registration is missing.");
            return Path.Combine(Path.GetDirectoryName(manifestPath), "native-host.config.json");
        }
    }

    private static Dictionary<string, object> ReadConfig()
    {
        return Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(ResolveConfigPath()));
    }

    private static Dictionary<string, object> ReadRendezvous(Dictionary<string, object> config)
    {
        string path = config["rendezvousPath"] as string;
        try
        {
            Dictionary<string, object> value =
                Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
            string urlValue = value["localAppServerUrl"] as string;
            Uri url;
            int pid = Convert.ToInt32(value["pid"]);
            int protocolVersion = Convert.ToInt32(value["protocolVersion"]);
            if (!Uri.TryCreate(urlValue, UriKind.Absolute, out url) ||
                url.Scheme != "ws" || url.Host != "127.0.0.1" || url.AbsolutePath != "/app-server" ||
                !Regex.IsMatch(url.Query, @"(?:^|[?&])token=[0-9a-f]{64}(?:&|$)") ||
                protocolVersion != ProtocolVersion)
                return null;
            Process process = Process.GetProcessById(pid);
            if (process.HasExited) return null;
            return value;
        }
        catch
        {
            return null;
        }
    }

    private static void StartApplication(Dictionary<string, object> config, bool restart)
    {
        object rawRequiredPath;
        if (config.TryGetValue("requiredPath", out rawRequiredPath))
        {
            string requiredPath = rawRequiredPath as string;
            if (String.IsNullOrWhiteSpace(requiredPath) || !File.Exists(requiredPath))
                throw new InvalidOperationException(
                    "The desktop development build is not ready. Start it from the development terminal first.");
        }
        object rawRequiredUrl;
        if (config.TryGetValue("requiredUrl", out rawRequiredUrl))
        {
            string requiredUrl = rawRequiredUrl as string;
            try
            {
                HttpWebRequest request = WebRequest.CreateHttp(requiredUrl);
                request.Method = "GET";
                request.Proxy = null;
                request.Timeout = 1000;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) { }
            }
            catch
            {
                throw new InvalidOperationException(
                    "The desktop development server is not ready. Start it from the development terminal first.");
            }
        }
        List<string> arguments = new List<string>();
        object rawArguments;
        if (config.TryGetValue("executableArguments", out rawArguments))
        {
            IEnumerable entries = rawArguments as IEnumerable;
            if (entries != null)
            {
                foreach (object value in entries) arguments.Add(Convert.ToString(value));
            }
        }
        if (restart) arguments.Add("--justdo-browser-extension-restart-app-server");
        ProcessStartInfo startInfo = new ProcessStartInfo
        {
            FileName = config["executablePath"] as string,
            Arguments = String.Join(" ", arguments.Select(QuoteArgument)),
            WorkingDirectory = config["workingDirectory"] as string,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        startInfo.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
        object rawEnvironment;
        if (config.TryGetValue("environment", out rawEnvironment))
        {
            Dictionary<string, object> environment = rawEnvironment as Dictionary<string, object>;
            if (environment != null)
            {
                foreach (KeyValuePair<string, object> entry in environment)
                    startInfo.EnvironmentVariables[entry.Key] = Convert.ToString(entry.Value);
            }
        }
        Process.Start(startInfo);
    }

    private static Dictionary<string, object> EnsureAppServer(bool restart)
    {
        Dictionary<string, object> config = ReadConfig();
        Dictionary<string, object> existing = ReadRendezvous(config);
        if (existing != null && !restart) return existing;
        if (restart)
        {
            try { File.Delete(config["rendezvousPath"] as string); }
            catch { }
        }
        StartApplication(config, restart);
        DateTime deadline = DateTime.UtcNow.AddSeconds(15);
        while (DateTime.UtcNow < deadline)
        {
            Thread.Sleep(100);
            Dictionary<string, object> rendezvous = ReadRendezvous(config);
            if (rendezvous != null) return rendezvous;
        }
        throw new InvalidOperationException("Unable to start the desktop app server.");
    }

    private static object Handle(Dictionary<string, object> request)
    {
        object id;
        request.TryGetValue("id", out id);
        object jsonRpc;
        object methodValue;
        if (!request.TryGetValue("jsonrpc", out jsonRpc) || Convert.ToString(jsonRpc) != "2.0" ||
            !request.TryGetValue("method", out methodValue))
            return new { jsonrpc = "2.0", id = id, error = new { code = -32600, message = "Invalid request." } };
        string method = methodValue as string;
        try
        {
            if (method == "codexRuntime/hello")
                return new
                {
                    jsonrpc = "2.0",
                    id = id,
                    result = new
                    {
                        manifestSchemaVersion = 2,
                        nativeHostProtocolVersion = ProtocolVersion,
                        supportedProtocolVersions = new[] { ProtocolVersion },
                    },
                };
            if (method == "codexRuntime/ensure" || method == "codexRuntime/restart")
            {
                Dictionary<string, object> rendezvous = EnsureAppServer(method == "codexRuntime/restart");
                return new
                {
                    jsonrpc = "2.0",
                    id = id,
                    result = new
                    {
                        localAppServerUrl = rendezvous["localAppServerUrl"],
                        runtimeConfig = new { protocolVersion = ProtocolVersion },
                    },
                };
            }
            return new { jsonrpc = "2.0", id = id, error = new { code = -32601, message = "Method not found." } };
        }
        catch (Exception error)
        {
            return new { jsonrpc = "2.0", id = id, error = new { code = -32603, message = error.Message } };
        }
    }

    public static int Main(string[] args)
    {
        if (!args.Any(argument => String.Equals(argument, ExtensionOrigin, StringComparison.Ordinal)))
            return 1;
        try
        {
            Stream input = Console.OpenStandardInput();
            Stream output = Console.OpenStandardOutput();
            while (true)
            {
                byte[] header = ReadExact(input, 4, true);
                if (header == null) return 0;
                int length = BitConverter.ToInt32(header, 0);
                if (length < 0 || length > MaxMessageBytes)
                    throw new InvalidDataException("Native message is too large.");
                byte[] body = ReadExact(input, length, false);
                object response;
                try
                {
                    Dictionary<string, object> request =
                        Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(body));
                    response = request == null
                        ? (object)new { jsonrpc = "2.0", id = (object)null, error = new { code = -32600, message = "Invalid request." } }
                        : Handle(request);
                }
                catch
                {
                    response = new { jsonrpc = "2.0", id = (object)null, error = new { code = -32700, message = "Parse error." } };
                }
                WriteMessage(output, response);
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("[BrowserExtensionNativeHost] " + error.Message);
            return 1;
        }
    }
}
