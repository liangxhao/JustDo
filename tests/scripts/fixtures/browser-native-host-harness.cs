using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Web.Script.Serialization;

internal static class NativeHostHarness
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    public static int Main(string[] args)
    {
        if (args[0] == "publish")
        {
            File.WriteAllText(args[2], Json.Serialize(args));
            File.WriteAllText(args[1], Json.Serialize(new
            {
                localAppServerUrl = "ws://127.0.0.1:41234/app-server?token=" + new string('a', 64),
                pid = Int32.Parse(args[3]),
                protocolVersion = 2,
            }));
            return 0;
        }

        Dictionary<string, object> config =
            Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(args[0]));
        MethodInfo ensure = typeof(BrowserExtensionNativeHost).GetMethod(
            "EnsureAppServer", BindingFlags.NonPublic | BindingFlags.Static);
        try
        {
            object result = ensure.Invoke(null, new object[] { config, args[1] == "restart" });
            Console.WriteLine(Json.Serialize(new { result = result }));
        }
        catch (TargetInvocationException error)
        {
            MethodInfo formatError = typeof(BrowserExtensionNativeHost).GetMethod(
                "ErrorResponse", BindingFlags.NonPublic | BindingFlags.Static);
            Console.WriteLine(Json.Serialize(new
            {
                error = error.InnerException.Message,
                response = formatError.Invoke(null, new object[] { null, error.InnerException }),
            }));
        }
        return 0;
    }
}
