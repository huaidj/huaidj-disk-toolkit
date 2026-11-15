using System.Text.Json;

namespace HuaiDJ.DiskToolkit.Desktop;

internal sealed class DesktopPreferences
{
    public bool English { get; set; }
    public string? LastJobId { get; set; }
    public string? LastJobToolkitRoot { get; set; }
    private static string Filename => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "HuaiDJ", "DiskToolkit", "desktop-settings.json");
    public static DesktopPreferences Load()
    {
        try { return JsonSerializer.Deserialize<DesktopPreferences>(File.ReadAllText(Filename)) ?? new(); }
        catch { return new(); }
    }
    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Filename)!);
            var temporary = Filename + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(this));
            File.Move(temporary, Filename, true);
        }
        catch { /* Preference persistence must not interrupt a physical job. */ }
    }
}
