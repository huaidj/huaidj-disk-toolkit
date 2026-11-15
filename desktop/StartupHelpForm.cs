namespace HuaiDJ.DiskToolkit.Desktop;

internal sealed class StartupHelpForm : Form
{
    public StartupHelpForm()
    {
        Text = "HuaiDJ 磁碟工具箱 — 尚未安裝核心"; StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(690, 460); MinimumSize = new Size(600, 400); BackColor = Color.White; AutoScaleMode = AutoScaleMode.Dpi;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(22), ColumnCount = 1, RowCount = 3 };
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.Controls.Add(new Label { Text = "尚未找到完整核心或執行環境", AutoSize = true, Font = new Font(Font, FontStyle.Bold), Margin = new Padding(0, 0, 0, 14) }, 0, 0);
        var guide = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, BorderStyle = BorderStyle.None, BackColor = Color.White, ScrollBars = ScrollBars.Vertical, Text = "請使用完整的HuaiDJ磁碟工具箱安裝包，讓安裝程式一併準備核心、Node與PowerShell。\r\n\r\n不要把這個EXE單獨移出完整app資料夾。安裝完成後，從安裝捷徑啟動即可。\r\n\r\n開發版本可提供 --toolkit-root 指向含有src/cli.mjs的核心資料夾，必要時另提供 --node-path。此視窗不會自動連網安裝，也不會要求管理員權限。" };
        layout.Controls.Add(guide, 0, 1);
        var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.RightToLeft, WrapContents = true };
        var close = new Button { Text = "關閉", AutoSize = true, MinimumSize = new Size(85, 36), DialogResult = DialogResult.Cancel };
        var instructions = new Button { Text = "開啟安裝說明", AutoSize = true, MinimumSize = new Size(135, 36) };
        instructions.Click += (_, _) => MessageBox.Show(this, "1. 取得官方Windows桌面完整安裝包並核對下載雜湊。\r\n\r\n2. 執行安裝器預覽，確認安裝資料夾與必要執行環境；套用後讓整個app資料夾保持完整。\r\n\r\n3. 從安裝器建立的捷徑開啟HuaiDJ磁碟工具箱。安裝核心不需要關閉UAC或修改全域PATH。\r\n\r\n若需要AI協助，可先複製旁邊的安裝提示詞。", "安裝說明", MessageBoxButtons.OK, MessageBoxIcon.Information);
        var copy = new Button { Text = "複製安裝提示詞", AutoSize = true, MinimumSize = new Size(150, 36), BackColor = Color.FromArgb(36, 116, 79), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        copy.FlatAppearance.BorderSize = 0;
        copy.Click += (_, _) => { try { Clipboard.SetText("Please help me install the complete HuaiDJ Disk Toolkit Windows desktop package from its official project release. Verify the release checksums, preserve existing installations, and include the required Node and PowerShell runtimes. Show the concrete installation preview before applying it. Do not disable UAC, change global PATH without authorization, or install an unrestricted elevated service. Keep the desktop EXE with the complete application folder, then launch the installed shortcut."); copy.Text = "已複製"; } catch { copy.Text = "稍後重試複製"; } };
        buttons.Controls.Add(close); buttons.Controls.Add(instructions); buttons.Controls.Add(copy); layout.Controls.Add(buttons, 0, 2); Controls.Add(layout); CancelButton = close;
    }
}
