namespace HuaiDJ.DiskToolkit.Desktop;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.SetDefaultFont(new Font("Segoe UI", 10F));
        try
        {
            var options = LaunchOptions.Parse(args);
            Application.Run(new MainForm(options));
        }
        catch (Exception)
        {
            Application.Run(new StartupHelpForm());
        }
    }
}
