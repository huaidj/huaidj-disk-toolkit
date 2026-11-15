using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace HuaiDJ.DiskToolkit.Desktop;

internal sealed class ToolkitCliException(string code, string message, string diagnostics, string? jobId = null) : Exception(message)
{
    public string Code { get; } = code;
    public string Diagnostics { get; } = diagnostics;
    public string? JobId { get; } = jobId;
}

internal sealed class ToolkitClient(LaunchOptions options)
{
    public string Root => options.ToolkitRoot;
    public string NodePath => options.NodePath;
    public string LastDiagnostics { get; private set; } = "";

    public async Task<JsonElement> RunAsync(IReadOnlyList<string> arguments, CancellationToken cancellationToken = default, bool allowCancellation = true, string? selectedImagePath = null)
    {
        var start = new ProcessStartInfo
        {
            FileName = NodePath, WorkingDirectory = Root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        start.ArgumentList.Add(Path.Combine(Root, "src", "cli.mjs"));
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        if (!string.IsNullOrWhiteSpace(selectedImagePath)) start.Environment["HUAIDJ_SELECTED_IMAGE_ROOT"] = Path.GetDirectoryName(Path.GetFullPath(selectedImagePath))!;
        using var process = new Process { StartInfo = start };
        try
        {
            if (!process.Start()) throw new InvalidOperationException("The core process did not start.");
            var stdoutTask = process.StandardOutput.ReadToEndAsync();
            var stderrTask = process.StandardError.ReadToEndAsync();
            using var registration = allowCancellation ? cancellationToken.Register(() => { try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { } catch (System.ComponentModel.Win32Exception) { } }) : default;
            await process.WaitForExitAsync();
            var stdout = await stdoutTask; var stderr = await stderrTask;
            LastDiagnostics = $"Command: {string.Join(' ', arguments)}\r\nExit: {process.ExitCode}\r\n\r\n{stderr}\r\n{stdout}";
            if (allowCancellation && cancellationToken.IsCancellationRequested) throw new OperationCanceledException(cancellationToken);
            if (process.ExitCode != 0)
            {
                var code = "CORE_ERROR"; var message = "The toolkit could not finish this operation."; string? jobId = null;
                foreach (var line in stderr.Split('\n', StringSplitOptions.RemoveEmptyEntries).Reverse())
                {
                    try { using var error = JsonDocument.Parse(line); code = error.RootElement.String("error", code); message = error.RootElement.String("message", message); jobId = error.RootElement.String("jobId", error.RootElement.String("job_id")); break; } catch (JsonException) { }
                }
                throw new ToolkitCliException(code, message, LastDiagnostics, jobId);
            }
            try { using var document = JsonDocument.Parse(stdout.TrimStart('\uFEFF')); return document.RootElement.Clone(); }
            catch (JsonException error) { throw new ToolkitCliException("INVALID_CORE_RESPONSE", "The toolkit response could not be read.", LastDiagnostics + "\r\n" + error.Message); }
        }
        catch (ToolkitCliException) { throw; }
        catch (OperationCanceledException) { throw; }
        catch (Exception error)
        {
            LastDiagnostics = $"Command: {string.Join(' ', arguments)}\r\n{error}";
            throw new ToolkitCliException("CORE_START_FAILED", "The toolkit core or Node runtime could not be started.", LastDiagnostics);
        }
    }
}
