// The small program that sits on its own at the top of the release folder, so people see one thing to open.
// It starts the real app (app\<same name>.exe, Electron and its files) and passes on any arguments, then exits.
// Built by tools/build_release.py with the C# compiler that comes with Windows (.NET Framework 4), which also
// writes the name and version (LauncherInfo.cs). No network, no settings, nothing else.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

static class Launcher
{
    [STAThread]
    static int Main(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string exe = Path.Combine(Path.Combine(dir, "app"), LauncherInfo.Target);
        if (!File.Exists(exe))
        {
            MessageBox.Show("Couldn't find the app's files:\n" + exe + "\n\nExtract the whole zip (right-click it, Extract All...) " +
                "and keep the \"app\" folder next to this program.", LauncherInfo.Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        var psi = new ProcessStartInfo(exe, JoinArgs(args));
        psi.UseShellExecute = false;
        psi.WorkingDirectory = Path.GetDirectoryName(exe);
        try { Process.Start(psi); }
        catch (Exception e)
        {
            MessageBox.Show("Couldn't start " + exe + "\n\n" + e.Message, LauncherInfo.Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        return 0;
    }

    // Quote arguments the way Windows programs read them back (CommandLineToArgvW rules).
    static string JoinArgs(string[] args)
    {
        var sb = new StringBuilder();
        foreach (string a in args)
        {
            if (sb.Length > 0) sb.Append(' ');
            if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) { sb.Append(a); continue; }
            sb.Append('"');
            int slashes = 0;
            foreach (char c in a)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') sb.Append('\\', slashes * 2 + 1);
                else sb.Append('\\', slashes);
                slashes = 0;
                sb.Append(c);
            }
            sb.Append('\\', slashes * 2);
            sb.Append('"');
        }
        return sb.ToString();
    }
}
