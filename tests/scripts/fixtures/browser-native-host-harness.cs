using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Microsoft.Win32;

internal static class NativeHostHarness
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    [DllImport("advapi32.dll")]
    private static extern int RegOverridePredefKey(IntPtr key, IntPtr replacement);

    private static int RunIsolatedStdio(string manifestPath, string origin)
    {
        // Override HKCU only inside this fixture process. Chrome and the user's
        // application registration keep their original registry and discovery.
        string sandboxPath = @"Software\BrowserExtensionTests\" + Guid.NewGuid().ToString("N");
        IntPtr currentUser = new IntPtr(unchecked((int)0x80000001));
        using (RegistryKey sandbox = Registry.CurrentUser.CreateSubKey(sandboxPath))
        {
            using (RegistryKey host = sandbox.CreateSubKey(
                @"Software\Google\Chrome\NativeMessagingHosts\com.justdo.browserextension"))
                host.SetValue(null, manifestPath);
            if (RegOverridePredefKey(currentUser, sandbox.Handle.DangerousGetHandle()) != 0)
                throw new InvalidOperationException("Could not isolate the fixture registry.");
            try
            {
                return BrowserExtensionNativeHost.Main(new[] { origin });
            }
            finally
            {
                RegOverridePredefKey(currentUser, IntPtr.Zero);
                Registry.CurrentUser.DeleteSubKeyTree(sandboxPath);
            }
        }
    }

    public static int Main(string[] args)
    {
        if (args[0] == "stdio") return RunIsolatedStdio(args[1], args[2]);
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
