namespace HuaiDJ.DiskToolkit.Desktop;

internal sealed class ReviewDialog : Form
{
    public ReviewDialog(string title, string details, bool destructive, bool english)
    {
        Text = title; StartPosition = FormStartPosition.CenterParent; ShowInTaskbar = false;
        MinimumSize = new Size(620, 460); Size = new Size(740, 540); MinimizeBox = false; MaximizeBox = false;
        BackColor = Color.White; AutoScaleMode = AutoScaleMode.Dpi;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Padding = new Padding(20) };
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        var heading = new Label { Text = title, AutoSize = true, Font = new Font(Font, FontStyle.Bold), Margin = new Padding(0, 0, 0, 14) };
        var content = new TextBox { Multiline = true, ReadOnly = true, Dock = DockStyle.Fill, BorderStyle = BorderStyle.None, BackColor = Color.White, ScrollBars = ScrollBars.Vertical, Text = details, TabStop = false };
        var confirm = new CheckBox { AutoSize = true, MaximumSize = new Size(660, 0), Text = destructive ? (english ? "I checked the USB and agree to the exact erase/restore scope above." : "我已確認選對USB，並同意上述清除或還原範圍。") : (english ? "I understand this snapshot contains export metadata, not my music files." : "我了解這份快照只包含匯出資料，不包含音樂檔。"), Margin = new Padding(0, 14, 0, 14) };
        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.RightToLeft, WrapContents = false };
        var proceed = new Button { AutoSize = true, MinimumSize = new Size(180, 38), Enabled = false, Text = destructive ? (english ? "Confirm and start" : "確認範圍並開始") : (english ? "Create snapshot" : "建立版本快照"), BackColor = Color.FromArgb(36, 116, 79), ForeColor = Color.White, FlatStyle = FlatStyle.Flat, DialogResult = DialogResult.OK };
        proceed.FlatAppearance.BorderSize = 0;
        var cancel = new Button { Text = english ? "Cancel" : "取消", AutoSize = true, MinimumSize = new Size(90, 38), DialogResult = DialogResult.Cancel };
        confirm.CheckedChanged += (_, _) => proceed.Enabled = confirm.Checked;
        actions.Controls.Add(proceed); actions.Controls.Add(cancel);
        layout.Controls.Add(heading, 0, 0); layout.Controls.Add(content, 0, 1); layout.Controls.Add(confirm, 0, 2); layout.Controls.Add(actions, 0, 3);
        Controls.Add(layout); CancelButton = cancel;
    }
}
