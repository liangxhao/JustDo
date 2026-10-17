using Microsoft.Win32;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal static class BrowserExtensionNativeHost
{
    private const string ExtensionOrigin = "chrome-extension://jboajogplelmaahjbomgflnfngpolgcb/";
    private const string HostName = "com.justdo.browserextension";
    private const int MaxMessageBytes = 1024 * 1024;
    private const int ProtocolVersion = 2;
    private const string AppNotRunningCode = "APP_NOT_RUNNING";
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    private sealed class AppNotRunningException : InvalidOperationException
    {
        public AppNotRunningException() : base(
            "The desktop app is not running. Start it manually, then reconnect the extension.") { }
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

    private static Dictionary<string, object> EnsureAppServer(Dictionary<string, object> config, bool restart)
    {
        if (restart)
            throw new InvalidOperationException(
                "Restarting the desktop app from the extension is disabled. Restart the app manually.");
        Dictionary<string, object> existing = ReadRendezvous(config);
        if (existing != null) return existing;
        throw new AppNotRunningException();
    }

    private static object ErrorResponse(object id, Exception error)
    {
        return new
        {
            jsonrpc = "2.0",
            id = id,
            error = new
            {
                code = -32603,
                message = error.Message,
                data = error is AppNotRunningException ? new { code = AppNotRunningCode } : null,
            },
        };
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
                Dictionary<string, object> rendezvous = EnsureAppServer(ReadConfig(), method == "codexRuntime/restart");
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
            return ErrorResponse(id, error);
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
