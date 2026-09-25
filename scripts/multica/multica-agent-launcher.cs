using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;

internal static class MulticaAgentLauncher
{
    private const string AgentSuffix = "-agent";
    private const string BridgeSwitch = "--justdo-multica-bridge";
    private const string ProductExecutableOverride = null;
    private const string ApplicationPathOverride = null;

    [STAThread]
    private static int Main()
    {
        try
        {
            string launcherPath = Process.GetCurrentProcess().MainModule.FileName;
            string launcherName = Path.GetFileNameWithoutExtension(launcherPath);
            if (!launcherName.EndsWith(AgentSuffix, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Agent launcher filename is invalid.");

            string productName = launcherName.Substring(0, launcherName.Length - AgentSuffix.Length);
            string productExecutable = ProductExecutableOverride ?? Path.Combine(
                Path.GetDirectoryName(launcherPath), productName + ".exe"
            );
            if (!File.Exists(productExecutable))
                throw new FileNotFoundException("The product executable is missing.", productExecutable);

            string[] arguments = Environment.GetCommandLineArgs().Skip(1).ToArray();
            string[] childArguments = ApplicationPathOverride == null
                ? new[] { BridgeSwitch }.Concat(arguments).ToArray()
                : new[] { ApplicationPathOverride, BridgeSwitch }.Concat(arguments).ToArray();
            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = productExecutable,
                Arguments = JoinArguments(childArguments),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Environment.CurrentDirectory,
            };
            string[] exactBlockedVariables = {
                "NODE_ENV", "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH",
                "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "OPENCLAW_STATE_DIR",
                "OPENCLAW_HOME", "OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PORT"
            };
            foreach (string name in exactBlockedVariables)
                startInfo.EnvironmentVariables.Remove(name);
            foreach (string name in startInfo.EnvironmentVariables.Keys.Cast<string>().ToArray())
            {
                string upper = name.ToUpperInvariant();
                if (upper.StartsWith("JUSTDO_", StringComparison.Ordinal) ||
                    upper.StartsWith("ELECTRON_", StringComparison.Ordinal) ||
                    upper.StartsWith("OPENCLAW_BUNDLED_", StringComparison.Ordinal))
                    startInfo.EnvironmentVariables.Remove(name);
            }

            using (Process child = Process.Start(startInfo))
            {
                Console.CancelKeyPress += (sender, eventArgs) =>
                {
                    eventArgs.Cancel = true;
                    try { if (!child.HasExited) child.Kill(); } catch { }
                };
                Thread stdoutThread = Copy(child.StandardOutput.BaseStream, Console.OpenStandardOutput());
                Thread stderrThread = Copy(child.StandardError.BaseStream, Console.OpenStandardError());
                child.WaitForExit();
                stdoutThread.Join();
                stderrThread.Join();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Agent launcher failed: " + error.Message);
            return 70;
        }
    }

    private static Thread Copy(Stream source, Stream destination)
    {
        Thread thread = new Thread(() =>
        {
            try { source.CopyTo(destination); destination.Flush(); }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
        });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    private static string JoinArguments(string[] arguments)
    {
        return string.Join(" ", arguments.Select(QuoteArgument));
    }

    private static string QuoteArgument(string argument)
    {
        if (argument.Length > 0 && !argument.Any(character => char.IsWhiteSpace(character) || character == '"'))
            return argument;
        StringBuilder result = new StringBuilder();
        result.Append('"');
        int backslashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\') { backslashes += 1; continue; }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes);
            backslashes = 0;
            result.Append(character);
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }
}
