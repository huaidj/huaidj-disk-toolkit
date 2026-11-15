using System.Text.Json;

namespace HuaiDJ.DiskToolkit.Desktop;

internal sealed record LaunchOptions(string ToolkitRoot, string NodePath)
{
    public static LaunchOptions Parse(string[] args)
    {
        string? requestedRoot = null, requestedNode = null;
        for (var index = 0; index < args.Length; index++)
        {
            var flag = args[index];
            if (flag is not ("--toolkit-root" or "--node-path") || index + 1 >= args.Length)
                throw new ArgumentException("Use --toolkit-root <folder> and optional --node-path <node.exe>.");
            var value = args[++index];
            if (flag == "--toolkit-root") requestedRoot = value; else requestedNode = value;
        }
        if (requestedRoot is not null && !Path.IsPathFullyQualified(requestedRoot))
            throw new ArgumentException("The toolkit root must be an absolute folder path.");
        string? root = requestedRoot is null ? null : Path.GetFullPath(requestedRoot);
        string? receiptNode = null;
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        for (var depth = 0; root is null && current is not null && depth < 8; depth++, current = current.Parent)
        {
            if (IsToolkit(current.FullName)) { root = current.FullName; break; }
            foreach (var filename in new[] { "current-install.json", "install-receipt.json", "current.json" })
            {
                var receipt = Path.Combine(current.FullName, filename);
                if (!File.Exists(receipt)) continue;
                try
                {
                    using var document = JsonDocument.Parse(File.ReadAllText(receipt));
                    foreach (var key in new[] { "toolkitRoot", "appRoot", "currentInstallRoot", "installRoot" })
                    {
                        var candidate = document.RootElement.String(key);
                        if (candidate.Length > 0 && IsToolkit(candidate)) { root = Path.GetFullPath(candidate); break; }
                        if (candidate.Length > 0 && IsToolkit(Path.Combine(candidate, "app"))) { root = Path.GetFullPath(Path.Combine(candidate, "app")); break; }
                    }
                    if (root is null && IsToolkit(Path.Combine(current.FullName, "app"))) root = Path.Combine(current.FullName, "app");
                    if (root is not null) { receiptNode = document.RootElement.String("nodePath"); break; }
                }
                catch (IOException) { }
                catch (JsonException) { }
            }
        }
        if (root is null || !IsToolkit(root)) throw new DirectoryNotFoundException("The installed toolkit core could not be located.");
        // The install receipt is beside app/, while the executable may already
        // have discovered app/src directly. Resolve its portable Node even then.
        var receiptParent = new DirectoryInfo(root);
        for (var depth = 0; string.IsNullOrWhiteSpace(receiptNode) && receiptParent is not null && depth < 3; depth++, receiptParent = receiptParent.Parent)
        {
            var receipt = Path.Combine(receiptParent.FullName, "install-receipt.json");
            if (!File.Exists(receipt)) continue;
            try { using var document = JsonDocument.Parse(File.ReadAllText(receipt)); receiptNode = document.RootElement.String("nodePath"); } catch (IOException) { } catch (JsonException) { }
        }
        var node = requestedNode;
        if (string.IsNullOrWhiteSpace(node) && !string.IsNullOrWhiteSpace(receiptNode) && File.Exists(receiptNode)) node = receiptNode;
        if (string.IsNullOrWhiteSpace(node)) node = new[] {
            Path.Combine(root, "runtime", "node.exe"), Path.Combine(root, "runtime", "node", "node.exe")
        }.FirstOrDefault(File.Exists);
        node = ResolveNode(node ?? "node.exe");
        if (node is null) throw new FileNotFoundException("The installed Node runtime could not be located.");
        return new LaunchOptions(Path.GetFullPath(root), node);
    }

    private static string? ResolveNode(string candidate)
    {
        if (Path.IsPathFullyQualified(candidate)) return File.Exists(candidate) ? Path.GetFullPath(candidate) : null;
        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try { var filename = Path.Combine(Environment.ExpandEnvironmentVariables(directory.Trim('"')), candidate); if (File.Exists(filename)) return Path.GetFullPath(filename); if (!Path.HasExtension(filename) && File.Exists(filename + ".exe")) return Path.GetFullPath(filename + ".exe"); }
            catch (ArgumentException) { }
        }
        return null;
    }
    private static bool IsToolkit(string folder)
    {
        if (!Directory.Exists(folder) || !File.Exists(Path.Combine(folder, "src", "cli.mjs"))) return false;
        try { using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(folder, "package.json"))); return document.RootElement.String("name") is "huaidj-rufus-mcp" or "huaidj-disk-toolkit"; }
        catch { return false; }
    }
}
