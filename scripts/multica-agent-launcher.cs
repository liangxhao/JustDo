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
            {
                throw new InvalidOperationException("Agent launcher filename is invalid.");
            }

            string productName = launcherName.Substring(0, launcherName.Length - AgentSuffix.Length);
            string productExecutable = ProductExecutableOverride ?? Path.Combine(
                Path.GetDirectoryName(launcherPath),
                productName + ".exe"
            );
            if (!File.Exists(productExecutable))
            {
                throw new FileNotFoundException("The product executable is missing.", productExecutable);
            }

            string[] arguments = Environment.GetCommandLineArgs().Skip(1).ToArray();
            string[] childArguments = ApplicationPathOverride == null
                ? new[] { BridgeSwitch }.Concat(arguments).ToArray()
                : new[] { ApplicationPathOverride, BridgeSwitch }.Concat(arguments).ToArray();
            WriteDiagnostic(productName, "received", arguments, null);
            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = productExecutable,
                // Electron's packaged argv shape can vary according to the parent process
                // environment. The explicit marker makes this invocation unambiguously a
                // bridge client before any single-instance or UI initialization occurs.
                Arguments = JoinArguments(childArguments),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Environment.CurrentDirectory,
            };
            startInfo.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");

            using (Process child = Process.Start(startInfo))
            {
                Thread stdoutThread = StartCopyThread(
                    child.StandardOutput.BaseStream,
                    Console.OpenStandardOutput()
                );
                Thread stderrThread = StartCopyThread(
                    child.StandardError.BaseStream,
                    Console.OpenStandardError()
                );
                child.WaitForExit();
                stdoutThread.Join();
                stderrThread.Join();
                WriteDiagnostic(productName, "completed", arguments, child.ExitCode);
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Agent launcher failed: " + error.Message);
            return 70;
        }
    }

    private static void WriteDiagnostic(
        string productName,
        string phase,
        string[] arguments,
        int? exitCode
    )
    {
        try
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string logDirectory = Path.Combine(appData, productName, "multica");
            Directory.CreateDirectory(logDirectory);
            string command = arguments.Length == 0 ? "none" : arguments[0];
            string line = string.Format(
                "{0:o} pid={1} phase={2} command={3} argc={4}{5}{6}",
                DateTime.UtcNow,
                Process.GetCurrentProcess().Id,
                phase,
                SanitizeDiagnosticValue(command),
                arguments.Length,
                exitCode.HasValue ? " exit=" : string.Empty,
                exitCode.HasValue ? exitCode.Value.ToString() : string.Empty
            );
            File.AppendAllText(Path.Combine(logDirectory, "agent-launcher.log"), line + Environment.NewLine);
        }
        catch
        {
            // Diagnostics must never prevent the transparent CLI relay from running.
        }
    }

    private static string SanitizeDiagnosticValue(string value)
    {
        if (value == "--version" || value == "config" || value == "agents" || value == "agent")
        {
            return value;
        }
        return "other";
    }

    private static Thread StartCopyThread(Stream source, Stream destination)
    {
        Thread thread = new Thread(() =>
        {
            source.CopyTo(destination);
            destination.Flush();
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
        {
            return argument;
        }

        StringBuilder result = new StringBuilder();
        result.Append('"');
        int backslashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\')
            {
                backslashes += 1;
                continue;
            }

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
