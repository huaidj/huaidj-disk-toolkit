using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace HuaiDJ.DiskToolkit.Desktop;

internal sealed class MainForm : Form
{
    private sealed record Words(string Chinese, string English);
    private sealed record Choice(string Value, string Chinese, string English, Func<bool> IsEnglish)
    { public override string ToString() => IsEnglish() ? English : Chinese; }
    private sealed record UsbDevice(int Number, string Model, long Size, string Identity, bool ReadOnly, bool Writable, bool Readable, string[] Letters, string Display, JsonElement Snapshot)
    { public override string ToString() => Display; }
    private sealed record PendingPlan(string Id, string Confirmation, string Executor, UsbDevice Device, int Revision, string Kind, string? ImagePath = null, string? ImageSha256 = null);
    private sealed record SnapshotChoice(string Id, JsonElement Summary, string Display) { public override string ToString() => Display; }

    private readonly ToolkitClient _client;
    private readonly DesktopPreferences _preferences = DesktopPreferences.Load();
    private readonly Color _accent = Color.FromArgb(36, 116, 79);
    private readonly List<Control> _inputs = [];
    private readonly ComboBox _devices = new() { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill };
    private readonly ComboBox _language = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 130 };
    private readonly Label _deviceSummary = new() { AutoSize = true, ForeColor = Color.DimGray, Dock = DockStyle.Fill };
    private readonly Button _refresh = new();
    private readonly Button _ai = new();
    private readonly TabControl _tabs = new() { Dock = DockStyle.Fill };
    private readonly DataGridView _modelTable = new() { Dock = DockStyle.Fill, AllowUserToAddRows = false, AllowUserToDeleteRows = false, RowHeadersVisible = false, MultiSelect = false, SelectionMode = DataGridViewSelectionMode.CellSelect, BackgroundColor = Color.White, BorderStyle = BorderStyle.FixedSingle, AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill };
    private readonly ComboBox _purpose = new() { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill };
    private readonly ComboBox _platform = new() { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill };
    private readonly ComboBox _fileClass = new() { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill };
    private readonly ComboBox _scheme = new() { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill };
    private readonly TextBox _version = new() { Dock = DockStyle.Fill };
    private readonly TextBox _volumeLabel = new() { Text = "DJUSB", Dock = DockStyle.Fill, MaxLength = 32 };
    private readonly CheckBox _quick = new() { Checked = true, AutoSize = true };
    private readonly Button _detect = new(), _recommend = new(), _previewFormat = new();
    private readonly Label _detection = new() { AutoSize = true, Dock = DockStyle.Fill, ForeColor = Color.DimGray };
    private readonly Label _recommendedFs = new() { AutoSize = true, Font = new Font("Segoe UI", 19, FontStyle.Bold), ForeColor = Color.FromArgb(27, 77, 54), Dock = DockStyle.Fill };
    private readonly Label _recommendationState = new() { AutoSize = true, Dock = DockStyle.Fill, ForeColor = Color.DimGray };
    private readonly TextBox _recommendationText = ReadonlyText();
    private readonly LinkLabel _sources = new() { AutoSize = true };
    private readonly TextBox _image = new() { Dock = DockStyle.Fill };
    private readonly TextBox _expectedHash = new() { Dock = DockStyle.Fill, MaxLength = 64 };
    private readonly ComboBox _imageMode = new() { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill };
    private readonly Button _browseImage = new(), _inspectImage = new(), _previewImage = new(), _verifyImage = new();
    private readonly TextBox _imageSummary = ReadonlyText();
    private readonly TextBox _libraryRoot = new() { Dock = DockStyle.Fill };
    private readonly TextBox _snapshotId = new() { Dock = DockStyle.Fill };
    private readonly ComboBox _snapshotChoices = new() { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList };
    private readonly Button _refreshSnapshots = new();
    private readonly CheckBox _includeAnalysis = new() { AutoSize = true };
    private readonly Button _browseLibrary = new(), _inspectLibrary = new(), _previewSnapshot = new(), _pickSnapshot = new(), _previewRestore = new();
    private readonly TextBox _librarySummary = ReadonlyText();
    private readonly Label _status = new() { AutoSize = true, Dock = DockStyle.Fill };
    private readonly Label _jobLabel = new() { AutoSize = true, ForeColor = Color.DimGray, Dock = DockStyle.Fill };
    private readonly ProgressBar _progress = new() { Dock = DockStyle.Fill, Height = 12 };
    private readonly Button _cancelRead = new(), _diagnostics = new();
    private readonly System.Windows.Forms.Timer _pollTimer = new() { Interval = 1500 };
    private readonly System.Windows.Forms.Timer _hotplugTimer = new() { Interval = 650 };
    private readonly List<string> _sourceUrls = [];
    private CancellationTokenSource? _readCancellation;
    private JsonElement _smartResult, _imageResult;
    private string? _inspectedImage, _inspectedReferenceHash, _activeJob, _jobKind, _jobImagePath, _jobImageSha;
    private UsbDevice? _jobDevice;
    private bool _english, _busy, _nonCancelable, _initializing = true, _refreshing, _polling;
    private int _revision;
    private bool _haveSmartResult;
    private bool _cachedTargetSupported = true;
    private bool _libraryRootAuto = true, _settingLibraryRoot;

    public MainForm(LaunchOptions options)
    {
        _client = new ToolkitClient(options); _english = _preferences.English;
        Text = "HuaiDJ 磁碟工具箱"; AutoScaleMode = AutoScaleMode.Dpi; BackColor = Color.FromArgb(248, 249, 248);
        StartPosition = FormStartPosition.CenterScreen; MinimumSize = new Size(980, 720); Size = new Size(1180, 850); KeyPreview = true; AllowDrop = true;
        BuildLayout(); WireEvents(); ApplyLanguage(); _initializing = false;
        Shown += async (_, _) => await InitializeAsync();
    }

    private string T(string chinese, string english) => _english ? english : chinese;
    private static TextBox ReadonlyText() => new() { Multiline = true, ReadOnly = true, Dock = DockStyle.Fill, ScrollBars = ScrollBars.Vertical, BorderStyle = BorderStyle.FixedSingle, BackColor = Color.White, Margin = new Padding(0, 10, 0, 10) };
    private Label Caption(string chinese, string english) => new() { Text = T(chinese, english), Tag = new Words(chinese, english), AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 7, 12, 7) };
    private void ButtonText(Button button, string chinese, string english, bool primary = false)
    {
        button.Text = T(chinese, english); button.Tag = new Words(chinese, english); button.AutoSize = true; button.MinimumSize = new Size(105, 36); button.Padding = new Padding(8, 1, 8, 1); button.Margin = new Padding(0, 0, 8, 0);
        if (primary) { button.BackColor = _accent; button.ForeColor = Color.White; button.FlatStyle = FlatStyle.Flat; button.FlatAppearance.BorderSize = 0; }
    }
    private ComboBox Choices(ComboBox box, params (string Value, string Chinese, string English)[] choices)
    { foreach (var choice in choices) box.Items.Add(new Choice(choice.Value, choice.Chinese, choice.English, () => _english)); box.SelectedIndex = 0; return box; }
    private static string Value(ComboBox box) => box.SelectedItem is Choice choice ? choice.Value : "";
    private UsbDevice? SelectedDevice => _devices.SelectedItem as UsbDevice;
    private TableLayoutPanel Grid(int columns = 1) => new() { Dock = DockStyle.Fill, ColumnCount = columns, AutoSize = true, Margin = Padding.Empty };
    private FlowLayoutPanel Actions(params Control[] controls)
    { var panel = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, WrapContents = true, Margin = new Padding(0, 8, 0, 8) }; panel.Controls.AddRange(controls); return panel; }
    private void AddSetting(TableLayoutPanel table, string chinese, string english, Control control)
    { var row = table.RowCount++; table.RowStyles.Add(new RowStyle(SizeType.AutoSize)); table.Controls.Add(Caption(chinese, english), 0, row); table.Controls.Add(control, 1, row); _inputs.Add(control); }

    private void BuildLayout()
    {
        var shell = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(18, 14, 18, 12), ColumnCount = 1, RowCount = 4 };
        shell.RowStyles.Add(new RowStyle(SizeType.AutoSize)); shell.RowStyles.Add(new RowStyle(SizeType.AutoSize)); shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        var heading = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, AutoSize = true, Margin = new Padding(0, 0, 0, 12) };
        heading.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); heading.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); heading.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        var title = Caption("HuaiDJ 磁碟工具箱", "HuaiDJ Disk Toolkit"); title.Font = new Font(Font, FontStyle.Bold); title.Margin = new Padding(0, 6, 0, 6);
        _language.Items.AddRange(["繁體中文", "English"]); _language.SelectedIndex = _english ? 1 : 0;
        ButtonText(_ai, "接入AI…", "Connect AI…"); heading.Controls.Add(title, 0, 0); heading.Controls.Add(_language, 1, 0); heading.Controls.Add(_ai, 2, 0);
        var deviceRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 2, AutoSize = true, Margin = new Padding(0, 0, 0, 14) };
        deviceRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); deviceRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); deviceRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        ButtonText(_refresh, "重新整理", "Refresh"); deviceRow.Controls.Add(Caption("USB裝置", "USB device"), 0, 0); deviceRow.Controls.Add(_devices, 1, 0); deviceRow.Controls.Add(_refresh, 2, 0); deviceRow.Controls.Add(_deviceSummary, 1, 1); deviceRow.SetColumnSpan(_deviceSummary, 2);
        _inputs.Add(_devices); _inputs.Add(_refresh);
        _tabs.TabPages.Add(BuildSmartPage()); _tabs.TabPages.Add(BuildImagePage()); _tabs.TabPages.Add(BuildLibraryPage());
        var footer = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 3, AutoSize = true, Padding = new Padding(0, 12, 0, 0) };
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        ButtonText(_cancelRead, "取消查詢", "Cancel query"); ButtonText(_diagnostics, "詳細診斷…", "Diagnostics…"); _cancelRead.Visible = false;
        footer.Controls.Add(_status, 0, 0); footer.Controls.Add(_cancelRead, 1, 0); footer.Controls.Add(_diagnostics, 2, 0); footer.Controls.Add(_jobLabel, 0, 1); footer.SetColumnSpan(_jobLabel, 3); footer.Controls.Add(_progress, 0, 2); footer.SetColumnSpan(_progress, 3); _progress.Visible = false;
        shell.Controls.Add(heading, 0, 0); shell.Controls.Add(deviceRow, 0, 1); shell.Controls.Add(_tabs, 0, 2); shell.Controls.Add(footer, 0, 3); Controls.Add(shell);
    }

    private TabPage BuildSmartPage()
    {
        var page = new TabPage { Tag = new Words("智慧格式化", "Smart format"), Padding = new Padding(16), BackColor = Color.White };
        var split = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1 };
        split.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 48)); split.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 52));
        var left = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Padding = new Padding(0, 0, 18, 0) };
        left.RowStyles.Add(new RowStyle(SizeType.AutoSize)); left.RowStyles.Add(new RowStyle(SizeType.AutoSize)); left.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); left.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        var settings = Grid(2); settings.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); settings.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        Choices(_purpose, ("dj", "DJ演出USB", "DJ performance USB"), ("shared-data", "Windows與Mac共用資料", "Shared Windows / Mac data"), ("windows-data", "Windows資料碟", "Windows data disk"), ("mac-data", "Mac資料碟", "Mac data disk"));
        Choices(_platform, ("windows,macos", "Windows + macOS", "Windows + macOS"), ("windows", "Windows", "Windows"), ("macos", "macOS", "macOS"));
        Choices(_fileClass, ("unknown", "尚未確認", "Not yet known"), ("within-fat32", "皆在FAT32單檔上限內（約4GB）", "All files fit FAT32's single-file limit"), ("over-fat32", "有檔案超過FAT32單檔上限", "At least one file exceeds the FAT32 limit"));
        _fileClass.DropDownWidth = 440;
        Choices(_scheme, ("auto", "沿用目前分割方式", "Retain current partition scheme"), ("mbr", "指定MBR", "Choose MBR"), ("gpt", "指定GPT", "Choose GPT"));
        AddSetting(settings, "用途", "Purpose", _purpose); AddSetting(settings, "整理平台", "Preparation hosts", _platform); AddSetting(settings, "最大單檔", "Largest individual file", _fileClass); AddSetting(settings, "分割方式", "Partition scheme", _scheme); AddSetting(settings, "rekordbox版本", "rekordbox version", _version);
        var modelHeader = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, AutoSize = true }; modelHeader.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); modelHeader.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        modelHeader.Controls.Add(Caption("使用的DJ設備（可複選）", "DJ equipment (select all used)"), 0, 0); ButtonText(_detect, "偵測設備", "Detect equipment"); modelHeader.Controls.Add(_detect, 1, 0);
        _modelTable.Columns.Add(new DataGridViewCheckBoxColumn { Name = "Use", HeaderText = "使用", FillWeight = 17 });
        _modelTable.Columns.Add(new DataGridViewTextBoxColumn { Name = "Model", HeaderText = "型號", ReadOnly = true, FillWeight = 48 });
        _modelTable.Columns.Add(new DataGridViewTextBoxColumn { Name = "Firmware", HeaderText = "韌體（選填）", FillWeight = 35 });
        _modelTable.RowTemplate.Height = 29; _modelTable.MinimumSize = new Size(0, 180); _inputs.Add(_modelTable); _inputs.Add(_detect);
        left.Controls.Add(settings, 0, 0); left.Controls.Add(modelHeader, 0, 1); left.Controls.Add(_modelTable, 0, 2); left.Controls.Add(_detection, 0, 3);
        var right = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 6, Padding = new Padding(18, 0, 0, 0) };
        right.RowStyles.Add(new RowStyle(SizeType.AutoSize)); right.RowStyles.Add(new RowStyle(SizeType.AutoSize)); right.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); right.RowStyles.Add(new RowStyle(SizeType.AutoSize)); right.RowStyles.Add(new RowStyle(SizeType.AutoSize)); right.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        right.Controls.Add(_recommendedFs, 0, 0); right.Controls.Add(_recommendationState, 0, 1); right.Controls.Add(_recommendationText, 0, 2);
        var formatSettings = Grid(2); formatSettings.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); formatSettings.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        AddSetting(formatSettings, "USB名稱", "Volume label", _volumeLabel); _quick.Tag = new Words("快速格式化", "Quick format"); _inputs.Add(_quick); formatSettings.Controls.Add(_quick, 1, formatSettings.RowCount++); right.Controls.Add(formatSettings, 0, 3);
        ButtonText(_recommend, "判定建議", "Assess options", true); ButtonText(_previewFormat, "預覽格式化…", "Preview format…"); _inputs.Add(_recommend); _inputs.Add(_previewFormat); right.Controls.Add(Actions(_recommend, _previewFormat), 0, 4);
        _sources.Tag = new Words("查看官方依據", "View official sources"); right.Controls.Add(_sources, 0, 5); split.Controls.Add(left, 0, 0); split.Controls.Add(right, 1, 0); page.Controls.Add(split); return page;
    }

    private TabPage BuildImagePage()
    {
        var page = new TabPage { Tag = new Words("系統安裝碟", "Boot media"), Padding = new Padding(20), BackColor = Color.White };
        var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 7 }; grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        grid.Controls.Add(Caption("ISO / IMG映像", "ISO / IMG image"), 0, 0); grid.Controls.Add(_image, 1, 0); ButtonText(_browseImage, "瀏覽…", "Browse…"); grid.Controls.Add(_browseImage, 2, 0);
        grid.Controls.Add(Caption("參考SHA-256（選填）", "Reference SHA-256 (optional)"), 0, 1); grid.Controls.Add(_expectedHash, 1, 1); grid.SetColumnSpan(_expectedHash, 2);
        Choices(_imageMode, ("auto", "自動判定DD或ISO", "Detect DD / ISO automatically"), ("dd", "DD完整映像", "DD full image"), ("iso", "ISO檔案模式", "ISO file mode")); grid.Controls.Add(Caption("寫入方式", "Write mode"), 0, 2); grid.Controls.Add(_imageMode, 1, 2); grid.SetColumnSpan(_imageMode, 2);
        var hint = Caption("沒有參考值時只計算雜湊，不代表已驗證發行者。製作USB不會自動安裝第二系統。", "Without a reference value, hashing does not verify the publisher. Preparing a USB does not install a second OS."); hint.MaximumSize = new Size(950, 0); grid.Controls.Add(hint, 0, 3); grid.SetColumnSpan(hint, 3);
        grid.RowStyles.Add(new RowStyle(SizeType.AutoSize)); grid.RowStyles.Add(new RowStyle(SizeType.AutoSize)); grid.RowStyles.Add(new RowStyle(SizeType.AutoSize)); grid.RowStyles.Add(new RowStyle(SizeType.AutoSize)); grid.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        grid.Controls.Add(_imageSummary, 0, 4); grid.SetColumnSpan(_imageSummary, 3);
        ButtonText(_inspectImage, "檢查映像", "Inspect image"); ButtonText(_previewImage, "預覽製作安裝碟…", "Preview boot USB…", true); ButtonText(_verifyImage, "讀回驗證", "Read back and verify");
        grid.Controls.Add(Actions(_inspectImage, _previewImage, _verifyImage), 0, 5); grid.SetColumnSpan(grid.GetControlFromPosition(0, 5)!, 3);
        _inputs.AddRange([_image, _expectedHash, _imageMode, _browseImage, _inspectImage, _previewImage, _verifyImage]); page.Controls.Add(grid); return page;
    }

    private TabPage BuildLibraryPage()
    {
        var page = new TabPage { Tag = new Words("資料庫保全", "Export-library preservation"), Padding = new Padding(20), BackColor = Color.White };
        var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 6 }; grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        grid.Controls.Add(Caption("USB / 匯出資料夾", "USB / export folder"), 0, 0); grid.Controls.Add(_libraryRoot, 1, 0); ButtonText(_browseLibrary, "瀏覽…", "Browse…"); grid.Controls.Add(_browseLibrary, 2, 0);
        var snapshotPicker = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, AutoSize = true }; snapshotPicker.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); snapshotPicker.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); ButtonText(_refreshSnapshots, "更新清單", "Refresh list"); snapshotPicker.Controls.Add(_snapshotChoices, 0, 0); snapshotPicker.Controls.Add(_refreshSnapshots, 1, 0);
        grid.Controls.Add(Caption("版本快照", "Metadata snapshot"), 0, 1); grid.Controls.Add(snapshotPicker, 1, 1); ButtonText(_pickSnapshot, "匯入清單…", "Import manifest…"); grid.Controls.Add(_pickSnapshot, 2, 1);
        _includeAnalysis.Tag = new Words("快照包括分析檔（仍不包含音樂）", "Include analysis files in snapshot (music is still excluded)"); grid.Controls.Add(_includeAnalysis, 1, 2); grid.SetColumnSpan(_includeAnalysis, 2);
        var hint = Caption("保存匯出資料庫與側錄檔。音樂檔及桌面主資料庫不包含；快照不是資料庫修復。還原會保留被替換的資料庫供回復。", "Preserve exported databases and sidecars. Music and the desktop main database are excluded; a snapshot is not database repair. Restore retains displaced metadata for rollback."); hint.MaximumSize = new Size(950, 0); grid.Controls.Add(hint, 0, 3); grid.SetColumnSpan(hint, 3);
        for (var index = 0; index < 4; index++) grid.RowStyles.Add(new RowStyle(SizeType.AutoSize)); grid.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        grid.Controls.Add(_librarySummary, 0, 4); grid.SetColumnSpan(_librarySummary, 3);
        ButtonText(_inspectLibrary, "檢查匯出資料庫", "Inspect export"); ButtonText(_previewSnapshot, "預覽版本快照…", "Preview snapshot…", true); ButtonText(_previewRestore, "預覽還原…", "Preview restore…"); grid.Controls.Add(Actions(_inspectLibrary, _previewSnapshot, _previewRestore), 0, 5); grid.SetColumnSpan(grid.GetControlFromPosition(0, 5)!, 3);
        _inputs.AddRange([_libraryRoot, _snapshotChoices, _refreshSnapshots, _includeAnalysis, _browseLibrary, _pickSnapshot, _inspectLibrary, _previewSnapshot, _previewRestore]); page.Controls.Add(grid); return page;
    }

    private void WireEvents()
    {
        _refresh.Click += async (_, _) => await RefreshDevicesAsync();
        _devices.SelectedIndexChanged += async (_, _) => await DeviceChangedAsync();
        _language.SelectedIndexChanged += (_, _) => { _english = _language.SelectedIndex == 1; _preferences.English = _english; _preferences.Save(); ApplyLanguage(); };
        _ai.Click += (_, _) => ShowAiPrompt(); _diagnostics.Click += (_, _) => ShowDiagnostics(); _sources.LinkClicked += (_, _) => ShowSources();
        _recommend.Click += async (_, _) => await RunUiAsync(AssessAsync, true);
        _detect.Click += async (_, _) => await RunUiAsync(DetectAsync, true);
        _previewFormat.Click += async (_, _) => await PreviewFormatAsync();
        _browseImage.Click += (_, _) => BrowseImage(); _inspectImage.Click += async (_, _) => await RunUiAsync(InspectImageAsync, true); _previewImage.Click += async (_, _) => await PreviewImageAsync(); _verifyImage.Click += async (_, _) => await StartReadbackAsync();
        _browseLibrary.Click += (_, _) => { using var dialog = new FolderBrowserDialog { Description = T("選擇USB根目錄或匯出資料夾", "Select the USB root or an exported copy") }; if (dialog.ShowDialog(this) == DialogResult.OK) _libraryRoot.Text = dialog.SelectedPath; };
        _pickSnapshot.Click += (_, _) => PickSnapshot(); _inspectLibrary.Click += async (_, _) => await RunUiAsync(InspectLibraryAsync, true); _previewSnapshot.Click += async (_, _) => await PreviewSnapshotAsync(); _previewRestore.Click += async (_, _) => await PreviewRestoreAsync();
        _refreshSnapshots.Click += async (_, _) => await RunUiAsync(async () => await ReloadSnapshotsAsync(_snapshotId.Text), true);
        _snapshotChoices.SelectedIndexChanged += (_, _) => { _snapshotId.Text = (_snapshotChoices.SelectedItem as SnapshotChoice)?.Id ?? ""; InputsChanged(); };
        _cancelRead.Click += (_, _) => _readCancellation?.Cancel();
        foreach (var control in new Control[] { _purpose, _platform, _fileClass, _scheme, _version, _volumeLabel, _quick, _image, _expectedHash, _imageMode, _libraryRoot, _snapshotId, _includeAnalysis })
        {
            if (control is ComboBox combo) combo.SelectedIndexChanged += (_, _) => InputsChanged();
            else if (control is CheckBox check) check.CheckedChanged += (_, _) => InputsChanged();
            else control.TextChanged += (_, _) => InputsChanged();
        }
        _image.TextChanged += (_, _) => InvalidateImage(); _expectedHash.TextChanged += (_, _) => InvalidateImage();
        _libraryRoot.TextChanged += (_, _) => { _librarySummary.Clear(); if (!_settingLibraryRoot && !_initializing) _libraryRootAuto = false; };
        _modelTable.CurrentCellDirtyStateChanged += (_, _) => { if (_modelTable.IsCurrentCellDirty) _modelTable.CommitEdit(DataGridViewDataErrorContexts.Commit); };
        _modelTable.CellValueChanged += (_, _) => InputsChanged(); _modelTable.DataError += (_, args) => args.ThrowException = false;
        _pollTimer.Tick += async (_, _) => await PollJobAsync();
        _hotplugTimer.Tick += async (_, _) => { _hotplugTimer.Stop(); if (!_busy && _activeJob is null) await RefreshDevicesAsync(); };
        KeyDown += async (_, args) => { if (args.KeyCode == Keys.F5 && !_busy && _activeJob is null) { args.Handled = true; await RefreshDevicesAsync(); } };
        DragEnter += (_, args) => { if (!_busy && args.Data?.GetData(DataFormats.FileDrop) is string[] files && files.Length == 1 && IsImage(files[0])) args.Effect = DragDropEffects.Copy; };
        DragDrop += (_, args) => { if (!_busy && _activeJob is null && args.Data?.GetData(DataFormats.FileDrop) is string[] files && files.Length == 1 && IsImage(files[0])) { _image.Text = files[0]; _tabs.SelectedIndex = 1; } };
        FormClosing += MainFormClosing;
    }

    protected override void WndProc(ref Message message)
    { base.WndProc(ref message); if (message.Msg == 0x0219 && !_busy && _activeJob is null) { _hotplugTimer.Stop(); _hotplugTimer.Start(); } }

    private async Task InitializeAsync()
    {
        await RunUiAsync(async () =>
        {
            var catalog = await _client.RunAsync(["dj-models"], ReadToken);
            _initializing = true;
            foreach (var model in catalog.Array("models")) { var index = _modelTable.Rows.Add(false, model.String("model"), ""); _modelTable.Rows[index].Tag = model.String("id"); }
            _initializing = false;
        }, true);
        await RefreshDevicesAsync();
        await ReloadSnapshotsAsync();
        if (Guid.TryParse(_preferences.LastJobId, out _) && string.Equals(_preferences.LastJobToolkitRoot, _client.Root, StringComparison.OrdinalIgnoreCase))
        { _activeJob = _preferences.LastJobId; _jobKind = "resumed"; _pollTimer.Start(); UpdateEnabled(); await PollJobAsync(); }
    }

    private void ApplyLanguage()
    {
        var previousInitializing = _initializing; _initializing = true;
        void Translate(Control control) { if (control.Tag is Words words) control.Text = T(words.Chinese, words.English); foreach (Control child in control.Controls) Translate(child); }
        Translate(this); Text = T("HuaiDJ 磁碟工具箱", "HuaiDJ Disk Toolkit");
        _modelTable.Columns[0].HeaderText = T("使用", "Use"); _modelTable.Columns[1].HeaderText = T("型號", "Model"); _modelTable.Columns[2].HeaderText = T("韌體（選填）", "Firmware (optional)");
        _version.PlaceholderText = T("例如7.2.13；不知道可留白", "For example 7.2.13; leave blank if unknown"); _image.PlaceholderText = T("選擇或拖入ISO / IMG檔案", "Choose or drop an ISO / IMG file"); _expectedHash.PlaceholderText = T("可貼上發行者提供的SHA-256", "Optional SHA-256 supplied by the publisher"); _snapshotId.PlaceholderText = T("貼上快照ID，或選擇manifest.json", "Paste a snapshot ID or choose manifest.json");
        foreach (var box in new[] { _purpose, _platform, _fileClass, _scheme, _imageMode }) { var index = box.SelectedIndex; var items = box.Items.Cast<object>().ToArray(); box.Items.Clear(); box.Items.AddRange(items); box.SelectedIndex = index; }
        var selectedIdentity = SelectedDevice?.Identity; var devices = _devices.Items.OfType<UsbDevice>().Select(device => device with { Display = device.Model + "  ·  " + Bytes(device.Size) + (device.Letters.Length > 0 ? "  ·  " + string.Join(" ", device.Letters.Select(letter => letter + ":")) : "") + (device.ReadOnly ? T("  ·  唯讀", "  ·  Read only") : "") }).ToArray();
        _devices.Items.Clear(); _devices.Items.Add(T("請選擇USB裝置", "Select a USB device")); foreach (var device in devices) _devices.Items.Add(device); _devices.SelectedItem = devices.FirstOrDefault(device => device.Identity == selectedIdentity); if (_devices.SelectedIndex < 0) _devices.SelectedIndex = 0;
        var selectedSnapshot = _snapshotId.Text; var snapshots = _snapshotChoices.Items.OfType<SnapshotChoice>().Select(choice => MakeSnapshotChoice(choice.Summary)).ToArray(); _snapshotChoices.Items.Clear(); _snapshotChoices.Items.Add(T("選擇日期與rekordbox版本", "Choose date and rekordbox version")); foreach (var snapshot in snapshots) _snapshotChoices.Items.Add(snapshot); _snapshotChoices.SelectedItem = snapshots.FirstOrDefault(snapshot => snapshot.Id == selectedSnapshot); if (_snapshotChoices.SelectedIndex < 0) _snapshotChoices.SelectedIndex = 0;
        _initializing = previousInitializing;
        if (!_haveSmartResult) { _recommendedFs.Text = T("先判定，再格式化", "Assess before formatting"); _recommendationState.Text = T("勾選現場設備，補上已知資訊後按「判定建議」。", "Select your equipment, add known details, then assess."); }
        else RenderRecommendation();
        if (string.IsNullOrEmpty(_status.Text)) _status.Text = T("就緒。請先選擇USB。", "Ready. Select a USB device first."); UpdateEnabled();
    }

    private void InputsChanged()
    {
        if (_initializing) return; _revision++; _haveSmartResult = false;
        _recommendedFs.Text = T("設定已變更", "Settings changed"); _recommendationState.Text = T("請重新判定；先前預覽已失效。", "Assess again; previous previews are no longer valid."); _recommendationText.Clear(); UpdateEnabled();
    }
    private void InvalidateImage() { _imageResult = default; _inspectedImage = null; _inspectedReferenceHash = null; _imageSummary.Text = T("映像尚未檢查。", "The image has not been inspected."); UpdateEnabled(); }
    private CancellationToken ReadToken => _readCancellation?.Token ?? CancellationToken.None;

    private async Task RefreshDevicesAsync()
    {
        if (_refreshing || _busy || _activeJob is not null) return; _refreshing = true; _refresh.Enabled = false;
        var previous = SelectedDevice?.Identity;
        try
        {
            var result = await _client.RunAsync(["devices"]);
            if (IsDisposed) return;
            var list = result.Array("devices").Where(value => value.String("busType").Equals("USB", StringComparison.OrdinalIgnoreCase)).Select(value =>
            {
                var letters = value.Strings("letters").ToArray(); var readOnly = value.Bool("isReadOnly"); var model = value.String("model"); var size = value.Long("size");
                var display = model + "  ·  " + Bytes(size) + (letters.Length > 0 ? "  ·  " + string.Join(" ", letters.Select(letter => letter + ":")) : "") + (readOnly ? T("  ·  唯讀", "  ·  Read only") : "");
                return new UsbDevice((int)value.Long("number"), model, size, value.String("identity"), readOnly, value.Bool("eligible"), value.Bool("readEligible", value.Bool("eligible")), letters, display, value.Clone());
            }).ToList();
            _initializing = true; _devices.Items.Clear(); _devices.Items.Add(T("請選擇USB裝置", "Select a USB device")); foreach (var device in list) _devices.Items.Add(device);
            var match = previous is null ? null : list.FirstOrDefault(device => device.Identity == previous); _devices.SelectedItem = match; if (_devices.SelectedIndex < 0) _devices.SelectedIndex = 0; _initializing = false;
            if (previous is not null && match is null) { InputsChanged(); _deviceSummary.Text = T("原USB已移除；不會自動改選另一支。", "The previous USB was removed; no other device was selected."); }
            else await DeviceChangedAsync();
            if (list.Count == 0) _deviceSummary.Text = T("尚未找到USB儲存裝置。插入後可按F5重新整理。", "No USB storage device found. Insert one and refresh with F5.");
        }
        catch (Exception error) { ShowError(error, false); }
        finally { _refreshing = false; UpdateEnabled(); }
    }

    private async Task DeviceChangedAsync()
    {
        if (_initializing) return; InputsChanged(); var device = SelectedDevice;
        if (device is null) { if (_libraryRootAuto) SetAutomaticLibraryRoot(""); _deviceSummary.Text = T("請先選擇要處理的USB。", "Choose the USB you intend to use."); UpdateEnabled(); return; }
        _deviceSummary.Text = device.Model + " · " + Bytes(device.Size) + T(" · 正在讀取分割區…", " · Reading partitions…");
        if (_libraryRootAuto) SetAutomaticLibraryRoot(device.Letters.Length > 0 ? device.Letters[0] + @":\" : "");
        try
        {
            var response = await _client.RunAsync(["details", "--device", device.Number.ToString(CultureInfo.InvariantCulture)]);
            if (IsDisposed || SelectedDevice?.Identity != device.Identity) return;
            var disk = response.Array("disks").FirstOrDefault();
            var formats = disk.Array("partitions").Select(partition => partition.Property("volume").String("filesystem")).Where(value => !string.IsNullOrWhiteSpace(value)).Distinct().ToArray();
            _deviceSummary.Text = device.Model + " · " + Bytes(device.Size) + " · " + (formats.Length > 0 ? string.Join(" / ", formats) : T("Windows未掛載可讀檔案系統", "No Windows-mounted filesystem")) + (device.ReadOnly ? T(" · 唯讀", " · Read only") : "");
        }
        catch { if (!IsDisposed && SelectedDevice?.Identity == device.Identity) _deviceSummary.Text = device.Model + " · " + Bytes(device.Size) + T(" · 暫時讀不到分割區資訊", " · Partition information unavailable"); }
        UpdateEnabled();
    }

    private List<string> SelectedModels() => _modelTable.Rows.Cast<DataGridViewRow>().Where(row => row.Cells[0].Value is true).Select(row => row.Tag?.ToString() ?? "").Where(value => value.Length > 0).ToList();
    private string FirmwarePairs() => string.Join(',', _modelTable.Rows.Cast<DataGridViewRow>().Where(row => row.Cells[0].Value is true && !string.IsNullOrWhiteSpace(row.Cells[2].Value?.ToString())).Select(row => row.Tag + "=" + row.Cells[2].Value!.ToString()!.Trim()));
    private async Task AssessAsync()
    {
        var models = SelectedModels();
        if (Value(_purpose) == "dj" && models.Count == 0) { _recommendedFs.Text = T("請選擇DJ型號", "Select DJ models"); _recommendationState.Text = T("未偵測到碟機也可手動勾選，USB品牌不能代替型號資訊。", "Manual selection works without connected players; a USB brand does not identify DJ equipment."); return; }
        var args = new List<string> { "smart-plan", "--purpose", Value(_purpose), "--platforms", Value(_platform), "--file-size-class", Value(_fileClass), "--scheme", Value(_scheme) }; var device = SelectedDevice;
        if (device is not null) args.AddRange(_cachedTargetSupported ? ["--target-json", device.Snapshot.GetRawText()] : ["--device", device.Number.ToString(CultureInfo.InvariantCulture)]);
        if (models.Count > 0) args.AddRange(["--models", string.Join(',', models)]);
        if (FirmwarePairs().Length > 0) args.AddRange(["--firmware", FirmwarePairs()]); if (_version.Text.Trim().Length > 0) args.AddRange(["--version", _version.Text.Trim()]);
        var revision = _revision; JsonElement response;
        try { response = await _client.RunAsync(args, ReadToken); }
        catch (ToolkitCliException error) when (device is not null && _cachedTargetSupported && error.Code == "ERR_PARSE_ARGS_UNKNOWN_OPTION")
        {
            _cachedTargetSupported = false; var flag = args.IndexOf("--target-json"); args.RemoveRange(flag, 2); args.AddRange(["--device", device.Number.ToString(CultureInfo.InvariantCulture)]); response = await _client.RunAsync(args, ReadToken);
        }
        if (revision != _revision) return; _smartResult = response; _haveSmartResult = true; RenderRecommendation();
    }

    private void RenderRecommendation()
    {
        var recommendation = _smartResult.Property("recommendation"); var fs = recommendation.String("filesystem", _smartResult.String("recommendedFilesystem"));
        _recommendedFs.Text = string.IsNullOrWhiteSpace(fs) ? T("尚無可確認的建議", "No confirmed recommendation") : FriendlyFilesystem(fs);
        var confidence = _smartResult.Property("confidence"); var level = confidence.Text(confidence.String("level"));
        _recommendationState.Text = level switch { "confirmed" or "documented-match" => T("目前輸入有官方資料支持，仍需實機驗收", "Current inputs have documented support; hardware acceptance is still needed"), "conditional" => T("條件式建議：請核對下列限制", "Conditional recommendation: review the limits below"), _ => T("參考建議；缺少的資訊會保留為未知", "Reference advice; missing facts remain unknown") };
        var text = new StringBuilder();
        var scheme = recommendation.String("partitionStyle"); if (scheme.Length > 0) text.AppendLine(T("分割方式：", "Partition scheme: ") + scheme.ToUpperInvariant());
        var libraries = recommendation.Strings("libraryFormats").ToArray();
        if (libraries.Length == 0) libraries = _smartResult.Array("libraryRequirements").SelectMany(value => value.Strings("supportedTypes")).Distinct().ToArray();
        if (libraries.Length > 0) text.AppendLine(T("匯出資料庫：", "Export libraries: ") + string.Join(" + ", libraries.Select(FriendlyLibrary)));
        foreach (var key in new[] { "missing", "warnings", "reasons" })
        {
            var messages = _smartResult.Array(key).Select(SmartMessage).Where(value => value.Length > 0).ToArray();
            if (messages.Length == 0) continue;
            text.AppendLine(); text.AppendLine(key switch { "missing" => T("尚需確認", "Still needed"), "warnings" => T("使用限制", "Limits"), _ => T("判定依據", "Decision reasons") }); foreach (var message in messages) text.AppendLine("• " + HumanReason(message));
        }
        if (_smartResult.String("exportRecommendation").Length > 0) text.AppendLine("\r\n" + HumanReason(_smartResult.String("exportRecommendation")));
        if (_smartResult.String("partitionRecommendation").Length > 0) text.AppendLine("\r\n" + HumanReason(_smartResult.String("partitionRecommendation")));
        if (SelectedDevice is null) text.AppendLine("\r\n" + T("選擇USB後才能預覽實際格式化。", "Select a USB before preparing an actual format plan."));
        if (!_smartResult.Has("canPrepare") && SelectedDevice is not null) text.AppendLine("\r\n" + T("此核心回應僅供相容性參考，尚未建立可執行計畫。", "This response is reference advice, not an executable plan."));
        _recommendationText.Text = text.ToString(); _sourceUrls.Clear(); _sourceUrls.AddRange(_smartResult.Strings("sourceURLs")); foreach (var source in _smartResult.Array("sources")) { var url = source.String("url", source.Text()); if (url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) _sourceUrls.Add(url); } UpdateEnabled();
    }

    private async Task DetectAsync()
    {
        var response = await _client.RunAsync(["detect-dj"], ReadToken); var ids = response.Array("devices").Select(device => device.String("modelId", device.String("id"))).Where(value => value.Length > 0).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var found = 0; foreach (DataGridViewRow row in _modelTable.Rows) if (ids.Contains(row.Tag?.ToString() ?? "")) { row.Cells[0].Value = true; found++; }
        _detection.Text = found > 0 ? T($"已勾選{found}個名稱匹配的候選；型號與韌體仍需你核對。", $"Selected {found} name-matched candidates; confirm the actual models and firmware.") : T("沒有可確認的機型線索；請手動勾選。", "No confirmed model hints found; select models manually.");
    }

    private async Task PreviewFormatAsync()
    {
        if (SelectedDevice is not { Writable: true } device || !_haveSmartResult || !_smartResult.Bool("canPrepare")) return;
        var revision = _revision; PendingPlan? pending = null; string details = "";
        await RunUiAsync(async () =>
        {
            var recommendation = _smartResult.Property("recommendation"); var options = recommendation.Property("nativeOptions"); var fs = options.String("filesystem", recommendation.String("filesystem")).ToLowerInvariant();
            if (!new[] { "fat32", "ntfs", "exfat" }.Contains(fs)) throw new ToolkitCliException("FILESYSTEM_UNAVAILABLE", "This Windows native formatter cannot create the recommended filesystem.", "");
            var args = new List<string> { "prepare-native-format", "--device", device.Number.ToString(CultureInfo.InvariantCulture), "--filesystem", fs, "--scheme", options.String("partitionScheme", recommendation.String("partitionStyle", Value(_scheme))).ToLowerInvariant(), "--label", _volumeLabel.Text };
            var cluster = options.Property("clusterSize").Text(); if (cluster.Length > 0) args.AddRange(["--cluster-size", cluster]); if (!_quick.Checked) args.Add("--full");
            var plan = await _client.RunAsync(args, ReadToken); pending = new PendingPlan(plan.String("planId"), plan.String("requiredConfirmation"), "write", device, revision, "format");
            details = DeviceReview(device) + "\r\n" + T("將清除整支USB的所有分割區與檔案。", "Every partition and file on this USB will be erased.") + "\r\n\r\n" + T("檔案系統：", "Filesystem: ") + FriendlyFilesystem(fs) + "\r\n" + T("USB名稱：", "Volume label: ") + _volumeLabel.Text + "\r\n" + T("分割方式：", "Partition scheme: ") + plan.Property("nativeOptions").String("partitionScheme", "auto").ToUpperInvariant() + "\r\n" + T("實際碟機播放仍需另外驗收。", "Playback on actual DJ hardware still needs separate acceptance.");
        }, true);
        if (pending is null || !PlanStillCurrent(pending)) return;
        using var dialog = new ReviewDialog(T("預覽USB格式化", "Review USB formatting"), details, true, _english);
        if (dialog.ShowDialog(this) == DialogResult.OK) await ExecutePlanAsync(pending);
    }

    private void BrowseImage()
    { using var dialog = new OpenFileDialog { Title = T("選擇系統映像", "Choose a system image"), Filter = "ISO / IMG|*.iso;*.img|All files|*.*", CheckFileExists = true }; if (dialog.ShowDialog(this) == DialogResult.OK) _image.Text = dialog.FileName; }
    private static bool IsImage(string filename) => new[] { ".iso", ".img" }.Contains(Path.GetExtension(filename).ToLowerInvariant());
    private async Task InspectImageAsync()
    {
        if (string.IsNullOrWhiteSpace(_image.Text)) return;
        var filename = Path.GetFullPath(_image.Text.Trim()); var reference = _expectedHash.Text.Trim(); var args = new List<string> { "inspect", "--image", filename }; if (reference.Length > 0) args.AddRange(["--sha256", reference]);
        var result = await _client.RunAsync(args, ReadToken, selectedImagePath: filename); _imageResult = result; _inspectedImage = filename; _inspectedReferenceHash = reference;
        var mode = result.Bool("rawWriteEligible") ? "DD" : result.Bool("discImage", result.Bool("iso9660")) ? "ISO" : T("尚未識別", "Not recognized");
        _imageSummary.Text = T("映像大小：", "Image size: ") + Bytes(result.Long("size")) + "\r\n" + T("自動寫入方式：", "Detected mode: ") + mode + "\r\n\r\nSHA-256\r\n" + result.String("sha256") + "\r\n\r\n" + (reference.Length > 0 ? T("已符合你提供的參考值；請自行確認該值的來源。", "Matches your supplied reference; verify where that reference came from.") : T("未提供參考值：這次只計算檔案雜湊，未驗證發行者。", "No reference supplied: only a file hash was calculated; publisher authenticity was not verified."));
    }
    private bool ImageInspected => _inspectedImage is not null && string.Equals(_inspectedImage, _image.Text.Trim(), StringComparison.OrdinalIgnoreCase) && _inspectedReferenceHash == _expectedHash.Text.Trim() && _imageResult.ValueKind == JsonValueKind.Object;
    private async Task PreviewImageAsync()
    {
        if (SelectedDevice is not { Writable: true } device) return; PendingPlan? pending = null; var revision = _revision; string details = "";
        await RunUiAsync(async () =>
        {
            if (!ImageInspected) await InspectImageAsync(); if (!ImageInspected) return;
            var mode = Value(_imageMode); if (mode == "auto") mode = _imageResult.Bool("rawWriteEligible") ? "dd" : _imageResult.Bool("discImage", _imageResult.Bool("iso9660")) ? "iso" : "";
            if (mode.Length == 0) throw new ToolkitCliException("IMAGE_TYPE_NOT_SUPPORTED", "The image has no recognized DD or ISO layout.", "");
            var hash = _imageResult.String("sha256"); var plan = await _client.RunAsync(["prepare", "--device", device.Number.ToString(CultureInfo.InvariantCulture), "--image", _inspectedImage!, "--sha256", hash, "--mode", mode], ReadToken, selectedImagePath: _inspectedImage);
            pending = new PendingPlan(plan.String("planId"), plan.String("requiredConfirmation"), "write", device, revision, "image", _inspectedImage, hash);
            details = DeviceReview(device) + "\r\n" + T("將清除整支USB的所有分割區與檔案。", "Every partition and file on this USB will be erased.") + "\r\n\r\n" + T("映像：", "Image: ") + Path.GetFileName(_inspectedImage) + "\r\n" + T("方式：", "Mode: ") + mode.ToUpperInvariant() + "\r\nSHA-256: " + hash + "\r\n\r\n" + T("此操作只製作USB；真正安裝第二系統仍需重啟並另定內部磁碟分割方案。", "This prepares only the USB. Installing a second OS still requires rebooting and a separate internal partition plan.");
        }, true);
        if (pending is null || !PlanStillCurrent(pending)) return; using var dialog = new ReviewDialog(T("預覽系統安裝碟", "Review boot media"), details, true, _english); if (dialog.ShowDialog(this) == DialogResult.OK) await ExecutePlanAsync(pending);
    }

    private bool PlanStillCurrent(PendingPlan plan) => plan.Revision == _revision && SelectedDevice?.Identity == plan.Device.Identity && SelectedDevice.Number == plan.Device.Number;
    private async Task RevalidateDeviceAsync(UsbDevice expected)
    {
        var inventory = await _client.RunAsync(["devices"]); var current = inventory.Array("devices").FirstOrDefault(value => value.String("identity") == expected.Identity);
        if (current.ValueKind != JsonValueKind.Object || current.Long("number") != expected.Number || current.Long("size") != expected.Size) throw new ToolkitCliException("DEVICE_CHANGED", "The USB changed. Prepare a fresh preview.", "");
    }
    private async Task ExecutePlanAsync(PendingPlan plan)
    {
        if (!PlanStillCurrent(plan)) { _status.Text = T("設定或USB已變更，請重新預覽。", "Settings or USB changed; prepare a new preview."); return; }
        await RunUiAsync(async () =>
        {
            await RevalidateDeviceAsync(plan.Device);
            _activeJob = plan.Id; _jobDevice = plan.Device; _jobKind = plan.Kind; _jobImagePath = plan.ImagePath; _jobImageSha = plan.ImageSha256; PersistJob();
            try
            {
                var args = new List<string> { plan.Executor, "--plan", plan.Id, "--confirm", plan.Confirmation }; if (plan.Kind != "verify") args.Add("--erase");
                var result = await _client.RunAsync(args, allowCancellation: false, selectedImagePath: plan.ImagePath);
                _activeJob = result.String("jobId", plan.Id); _status.Text = T("已提交工作，等待核心回報進度。", "Job submitted; waiting for core progress."); _pollTimer.Start(); PersistJob();
            }
            catch (ToolkitCliException error) when (error.Code == "SUBMISSION_UNKNOWN") { _status.Text = T("提交狀態不明：請先處理尚未回應的Windows提示，並等待工作狀態。", "Submission outcome unknown. Resolve any outstanding Windows prompt and check this job."); _pollTimer.Start(); }
            catch { _activeJob = null; PersistJob(); throw; }
        }, false);
    }
    private async Task StartReadbackAsync()
    {
        if (SelectedDevice is not { Readable: true } device) return; PendingPlan? pending = null; var revision = _revision;
        await RunUiAsync(async () =>
        {
            if (!ImageInspected) await InspectImageAsync(); if (!ImageInspected) return;
            var result = await _client.RunAsync(["prepare-verify", "--device", device.Number.ToString(CultureInfo.InvariantCulture), "--image", _inspectedImage!, "--sha256", _imageResult.String("sha256")], ReadToken, selectedImagePath: _inspectedImage);
            pending = new PendingPlan(result.String("planId"), result.String("requiredConfirmation"), "execute-disk", device, revision, "verify", _inspectedImage, _imageResult.String("sha256"));
        }, true);
        if (pending is not null && PlanStillCurrent(pending)) await ExecutePlanAsync(pending);
    }

    private async Task PollJobAsync()
    {
        if (_polling || _activeJob is null || IsDisposed) return; _polling = true;
        try
        {
            var result = await _client.RunAsync(["job", "--id", _activeJob]); if (IsDisposed) return;
            var state = result.String("state"); var native = result.Property("result"); var progress = (int)native.Long("progress");
            _progress.Visible = true; _progress.Style = native.Has("progress") ? ProgressBarStyle.Continuous : ProgressBarStyle.Marquee; if (native.Has("progress")) _progress.Value = Math.Clamp(progress, 0, 100);
            _jobLabel.Text = T("工作ID：", "Job ID: ") + _activeJob;
            if (state == "submission-unknown") _status.Text = T("提交狀態待確認；保留USB使用權，請勿重新提交。", "Submission remains uncertain; the USB reservation is retained. Do not resubmit.");
            else _status.Text = PhaseText(native.String("phase"), state);
            if (state is "completed" or "failed" or "start-failed")
            {
                _pollTimer.Stop(); var kind = _jobKind; _activeJob = null; PersistJob();
                if (state == "completed") _status.Text = kind == "verify" ? T("讀回驗證完成：USB映像與來源雜湊一致。", "Readback verified: USB image bytes match the source.") : kind == "image" ? T("映像寫入完成。可另按「讀回驗證」；實際開機尚未測試。", "Image write completed. Readback is available separately; actual boot is untested.") : T("工作完成，核心已回讀確認結果。", "Job completed and its result was read back by the core.");
                else _status.Text = ErrorText(native.String("error", result.Property("error").String("code")));
                _progress.Style = ProgressBarStyle.Continuous; _progress.Value = state == "completed" ? 100 : 0; UpdateEnabled(); await RefreshDevicesAsync();
            }
        }
        catch (Exception) { if (!IsDisposed) { _status.Text = T("暫時無法取得工作狀態，會保留工作並繼續查詢。", "Job status is temporarily unavailable; the job is retained and polling will continue."); _jobLabel.Text = T("工作ID：", "Job ID: ") + _activeJob; } }
        finally { _polling = false; UpdateEnabled(); }
    }

    private async Task InspectLibraryAsync()
    {
        var result = await _client.RunAsync(["export-inspect", "--root", _libraryRoot.Text.Trim()], ReadToken);
        var text = new StringBuilder(); text.AppendLine(result.Bool("metadataDirectoryPresent") ? T("找到匯出資料庫資料夾。", "An export-library metadata folder was found.") : T("未找到匯出資料庫資料夾。", "No export-library metadata folder was found."));
        foreach (var database in result.Array("databases")) text.AppendLine((database.Bool("present") ? "✓ " : "— ") + database.String("candidate") + (database.Bool("present") ? "  " + Bytes(database.Long("size")) : ""));
        text.AppendLine("\r\n" + T("檔案存在不代表資料庫完整，也不能單憑檔名判定版本或損壞。", "File presence does not prove database integrity, version or corruption."));
        if (result.Property("markerIndicators").Long("count") > 0) text.AppendLine(T("發現需要保留檢查的標記檔；不會自動刪除或修復。", "Markers require preservation and review; no automatic deletion or repair occurs.")); _librarySummary.Text = text.ToString();
    }
    private async Task PreviewSnapshotAsync()
    {
        JsonElement preview = default; var revision = _revision; var root = _libraryRoot.Text.Trim();
        await RunUiAsync(async () => { var args = new List<string> { "snapshot-preview", "--root", root }; if (_includeAnalysis.Checked) args.Add("--analysis"); preview = await _client.RunAsync(args, ReadToken); }, true);
        if (preview.ValueKind != JsonValueKind.Object || revision != _revision) return;
        var text = T("來源：", "Source: ") + root + "\r\n" + T("匯出資料檔案：", "Export metadata files: ") + preview.Long("fileCount") + "\r\n" + T("大小：", "Size: ") + Bytes(preview.Long("bytes")) + "\r\n\r\n" + T("不包含音樂檔。請先正常關閉所有rekordbox視窗與程序；核心會再確認。", "Music is excluded. Close all rekordbox windows/processes cleanly; the core checks again.");
        using var dialog = new ReviewDialog(T("預覽版本快照", "Review metadata snapshot"), text, false, _english); if (dialog.ShowDialog(this) != DialogResult.OK || revision != _revision) return;
        await RunUiAsync(async () => { var args = new List<string> { "snapshot-create", "--root", root }; if (_includeAnalysis.Checked) args.Add("--analysis"); if (_version.Text.Trim().Length > 0) args.AddRange(["--exporter-version", _version.Text.Trim()]); var result = await _client.RunAsync(args, allowCancellation: false); _snapshotId.Text = result.String("snapshotId"); _librarySummary.Text = T("版本快照已完成並驗證。", "Versioned metadata snapshot completed and verified.") + "\r\n" + T("檔案：", "Files: ") + result.Long("fileCount") + "\r\n" + T("不包含音樂；分析檔是否包含取決於這次選項。", "Music is excluded; analysis inclusion follows this snapshot option."); await ReloadSnapshotsAsync(_snapshotId.Text); }, false);
    }
    private void PickSnapshot()
    {
        using var dialog = new OpenFileDialog { Title = T("選擇版本快照清單", "Choose a snapshot manifest"), Filter = "HuaiDJ snapshot|manifest.json", CheckFileExists = true };
        var snapshots = Path.Combine(_client.Root, "state", "snapshots"); if (Directory.Exists(snapshots)) dialog.InitialDirectory = snapshots;
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        try { using var document = JsonDocument.Parse(File.ReadAllText(dialog.FileName)); var summary = document.RootElement.Clone(); var id = summary.String("snapshotId"); if (!Guid.TryParse(id, out _)) throw new JsonException(); var choice = MakeSnapshotChoice(summary); _snapshotChoices.Items.Add(choice); _snapshotChoices.SelectedItem = choice; }
        catch { _status.Text = T("這不是可辨識的HuaiDJ快照清單。", "This is not a recognized HuaiDJ snapshot manifest."); }
    }
    private SnapshotChoice MakeSnapshotChoice(JsonElement summary)
    {
        var created = summary.String("completedUTC", summary.String("createdUTC"));
        var date = DateTimeOffset.TryParse(created, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var stamp) ? stamp.ToLocalTime().ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture) : T("日期未提供", "Date not declared");
        var version = summary.String("exporterVersionDeclared"); if (version.Length == 0) version = T("版本未提供", "version not declared");
        var display = date + "  ·  rekordbox " + version;
        if (summary.Has("bytes")) display += "  ·  " + Bytes(summary.Long("bytes"));
        return new SnapshotChoice(summary.String("snapshotId"), summary.Clone(), display);
    }
    private async Task ReloadSnapshotsAsync(string? preferred = null)
    {
        preferred ??= _snapshotId.Text;
        try
        {
            var result = await _client.RunAsync(["snapshot-list"], ReadToken);
            if (IsDisposed) return;
            var rows = result.Array("snapshots").Where(value => value.String("status") == "complete-summary").OrderByDescending(value => value.String("createdUTC")).Select(MakeSnapshotChoice).ToArray();
            _initializing = true; _snapshotChoices.Items.Clear(); _snapshotChoices.Items.Add(T("選擇日期與rekordbox版本", "Choose date and rekordbox version")); foreach (var row in rows) _snapshotChoices.Items.Add(row);
            _snapshotChoices.DropDownWidth = 730; var selected = rows.FirstOrDefault(row => row.Id == preferred); _snapshotChoices.SelectedItem = selected; if (_snapshotChoices.SelectedIndex < 0) _snapshotChoices.SelectedIndex = 0; _snapshotId.Text = selected?.Id ?? "";
            _initializing = false;
        }
        catch
        {
            if (IsDisposed) return;
            _initializing = true; _snapshotChoices.Items.Clear(); _snapshotChoices.Items.Add(T("清單尚未載入；可選擇快照清單檔", "List unavailable; choose a snapshot manifest")); _snapshotChoices.SelectedIndex = 0; _snapshotId.Text = ""; _initializing = false;
        }
        UpdateEnabled();
    }
    private async Task PreviewRestoreAsync()
    {
        if (!LibraryRootMatchesSelectedUsb()) { _status.Text = T("請選擇快照所屬USB，並使用該USB的根目錄。", "Select the snapshot's USB and its root directory."); return; }
        JsonElement preview = default; var revision = _revision; var root = _libraryRoot.Text.Trim(); var snapshot = _snapshotId.Text.Trim();
        await RunUiAsync(async () => preview = await _client.RunAsync(["restore-preview", "--snapshot", snapshot, "--root", root], ReadToken), true);
        if (preview.ValueKind != JsonValueKind.Object || revision != _revision) return;
        var details = T("還原目標：", "Restore target: ") + root + "\r\n" + T("快照：", "Snapshot: ") + (_snapshotChoices.SelectedItem?.ToString() ?? T("已選取版本", "Selected version")) + "\r\n" + T("資料檔案：", "Metadata files: ") + preview.Long("fileCount") + "\r\n\r\n" + T("只還原PIONEER/rekordbox。現有資料庫會移入保留區供回復；音樂、分析檔和桌面主資料庫不會還原。請先正常關閉rekordbox。", "Only PIONEER/rekordbox is restored. Existing metadata moves into quarantine for rollback. Music, analysis and desktop main databases are excluded. Close rekordbox cleanly first.");
        using var dialog = new ReviewDialog(T("預覽匯出資料庫還原", "Review export-library restore"), details, true, _english); if (dialog.ShowDialog(this) != DialogResult.OK || revision != _revision) return;
        await RunUiAsync(async () => { var result = await _client.RunAsync(["snapshot-restore", "--snapshot", snapshot, "--root", root, "--preview", preview.String("previewId"), "--snapshot-identity", preview.String("snapshotIdentity"), "--confirm", preview.String("requiredConfirmation"), "--restore"], allowCancellation: false); _librarySummary.Text = T("資料庫位元組已還原並驗證。", "Export metadata bytes were restored and verified.") + "\r\n" + (result.Bool("rollbackAvailable") ? T("原資料庫已保留，可供回復。", "Displaced metadata was preserved for rollback.") : "") + "\r\n\r\n" + T("這不是資料庫修復或實際碟機播放驗收。", "This is not database repair or a DJ-player playback test."); }, false);
    }

    private async Task RunUiAsync(Func<Task> action, bool readOnly)
    {
        if (_busy || _activeJob is not null) return; _busy = true; _nonCancelable = !readOnly; _readCancellation = readOnly ? new CancellationTokenSource() : null;
        _status.Text = readOnly ? T("正在查詢…", "Reading…") : T("正在提交或執行工作…", "Submitting or running the operation…"); _progress.Visible = true; _progress.Style = ProgressBarStyle.Marquee; UpdateEnabled();
        try { await action(); if (!IsDisposed && _activeJob is null) _status.Text = T("完成。", "Done."); }
        catch (OperationCanceledException) { if (!IsDisposed) _status.Text = T("已取消查詢，沒有提交寫入。", "Query cancelled; no write was submitted."); }
        catch (Exception error) { if (!IsDisposed) ShowError(error, true); }
        finally { _readCancellation?.Dispose(); _readCancellation = null; _busy = false; _nonCancelable = false; if (!IsDisposed) { if (_activeJob is null) _progress.Visible = false; UpdateEnabled(); } }
    }

    private void UpdateEnabled()
    {
        if (IsDisposed) return; var available = !_busy && _activeJob is null;
        foreach (var control in _inputs) control.Enabled = available; _refresh.Enabled = available && !_refreshing;
        _modelTable.Enabled = available && Value(_purpose) == "dj"; _detect.Enabled = _modelTable.Enabled;
        _cancelRead.Visible = _busy && _readCancellation is not null; _cancelRead.Enabled = _cancelRead.Visible;
        _previewFormat.Enabled = available && SelectedDevice?.Writable == true && _haveSmartResult && _smartResult.Bool("canPrepare");
        _previewImage.Enabled = available && SelectedDevice?.Writable == true && _image.Text.Trim().Length > 0;
        _inspectImage.Enabled = available && _image.Text.Trim().Length > 0; _verifyImage.Enabled = available && SelectedDevice?.Readable == true && _image.Text.Trim().Length > 0;
        _inspectLibrary.Enabled = available && _libraryRoot.Text.Trim().Length > 0; _previewSnapshot.Enabled = _inspectLibrary.Enabled; _previewRestore.Enabled = _inspectLibrary.Enabled && LibraryRootMatchesSelectedUsb() && Guid.TryParse(_snapshotId.Text.Trim(), out _);
        _sources.Enabled = _sourceUrls.Count > 0; _jobLabel.Text = _activeJob is null ? "" : T("工作ID：", "Job ID: ") + _activeJob;
    }
    private void PersistJob() { _preferences.LastJobId = _activeJob; _preferences.LastJobToolkitRoot = _client.Root; _preferences.Save(); }
    private bool LibraryRootMatchesSelectedUsb()
    {
        var device = SelectedDevice; if (device is null) return false;
        try { var root = Path.GetFullPath(_libraryRoot.Text.Trim()).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar); return device.Letters.Any(letter => root.Equals(letter + ":", StringComparison.OrdinalIgnoreCase)); } catch { return false; }
    }
    private void SetAutomaticLibraryRoot(string value)
    { _settingLibraryRoot = true; try { _libraryRoot.Text = value; } finally { _settingLibraryRoot = false; } }
    private void MainFormClosing(object? sender, FormClosingEventArgs args)
    {
        if (_activeJob is not null || _nonCancelable)
        {
            var message = T("關閉視窗不會強制中斷已提交的格式化、寫入或還原。請保留USB連線，並在重新提交前確認前一工作的結果。", "Closing this window does not forcibly stop submitted formatting, writing or restore operations. Keep the USB connected and confirm the previous outcome before resubmitting.");
            if (_activeJob is not null) message += "\r\n" + T("下次開啟同一安裝會繼續查詢此工作。", "Reopening the same installation resumes polling this job.");
            var answer = MessageBox.Show(this, message + "\r\n\r\n" + T("仍要關閉視窗？", "Close the window?"), Text, MessageBoxButtons.YesNo, MessageBoxIcon.Information);
            if (answer != DialogResult.Yes) { args.Cancel = true; return; }
        }
        _readCancellation?.Cancel(); _pollTimer.Stop(); _hotplugTimer.Stop();
    }
    private string DeviceReview(UsbDevice device) => T("目標USB：", "Target USB: ") + device.Model + "\r\n" + T("容量：", "Capacity: ") + Bytes(device.Size) + "\r\n" + T("識別碼：", "Identity: ") + device.Identity[..Math.Min(16, device.Identity.Length)] + "\r\n" + T("磁碟機代號：", "Mounted letters: ") + (device.Letters.Length > 0 ? string.Join(", ", device.Letters.Select(value => value + ":")) : T("未掛載", "Not mounted"));
    private string FriendlyFilesystem(string value) => value.ToLowerInvariant() switch { "fat32" => "FAT32", "exfat" => "exFAT", "ntfs" => "NTFS", "hfsplus" => "HFS+", "apfs" => "APFS", _ => value };
    private string FriendlyLibrary(string value) => value.ToLowerInvariant() switch { "devicelibrary" => T("傳統Device Library", "Traditional Device Library"), "onelibrary" or "devicelibraryplus" => "OneLibrary", _ => value };
    private string HumanReason(string value)
    {
        if (_english) return value;
        return value.Replace("Partition-scheme evidence is incomplete. Do not apply an automatic DJ partition preset.", "分割方式的官方證據尚不完整；不會自動套用已認證的DJ分割預設。").Replace("Export and verify the traditional Device Library for the selected equipment.", "請匯出並核對這些設備使用的傳統Device Library。").Replace("windows native write support is not confirmed.", "尚未確認Windows原生寫入支援。").Replace("macos native write support is not confirmed.", "尚未確認macOS原生寫入支援。");
    }
    private string SmartMessage(JsonElement item)
    {
        var message = item.Text(item.String("message", item.String("reason"))); if (_english) return message;
        return item.String("code") switch
        {
            "SELECT_DJ_MODEL" => "請選擇或確認現場會使用的DJ設備型號。",
            "NO_CONFIRMED_SHARED_FILESYSTEM" => "目前沒有同時符合設備、整理平台與單檔大小的已確認格式。請補韌體、rekordbox版本，或調整檔案條件。",
            "MULTIPLE_LIBRARY_ECOSYSTEMS" => "這組設備同時使用Engine DJ與rekordbox；共用檔案系統不會自動建立兩套資料庫。",
            "DUAL_LIBRARY_REQUIRED" => "這組設備需要同時匯出傳統Device Library與OneLibrary。",
            "LIBRARY_SUPPORT_UNCONFIRMED" => "至少一個型號的資料庫格式證據尚不完整。",
            "FULL_REKORDBOX_VERSION_NEEDED" => "請補上完整rekordbox版本，才能核對該版本的USB匯出問題。",
            "KNOWN_EXPORT_DEFECT" => "你提供的rekordbox版本有已知USB匯出問題；格式化不能修復軟體版本問題。",
            "POTENTIAL_EXPORT_ADVISORY" => "可能有相關匯出公告；版本不完整時，不能直接判定這支USB受影響。",
            "MANUFACTURER_MEDIA_PREFERENCE" => "此容量與用途有原廠整理指南支持這個檔案系統選擇。",
            "EXISTING_LAYOUT_NOT_CERTIFIED" => "可以沿用目前分割表類型，但這不代表該型號已通過實際播放驗收。",
            "NATIVE_OS_DATA_PROFILE" => "這是依電腦資料用途選格式，不代表DJ碟機相容。",
            "PARTITION_SCHEME_CONFLICT" => "至少一個所選DJ型號明確不支援你指定的分割方式。",
            "OPERATOR_PARTITION_CHOICE" => "分割方式由你明確指定；仍需遵守機型已知限制。",
            "PARTITION_CHOICE_NEEDED" => "分割方式的資料不足。請查看原廠指南，或明確指定MBR / GPT。",
            "MBR_CAPACITY_LIMIT" => "超過2TiB的裝置不會自動截短成MBR；請改選合適方案。",
            "FAT32_FILE_LIMIT_UNCONFIRMED" => "FAT32每個檔案最多4,294,967,295位元組，目前尚未確認你的最大檔案。",
            "GENERAL_GUIDANCE_NOT_PLAYER_TEST" => "分割方式依原廠通用整理指南建議，尚未在每個所選碟機實測。",
            "SELECT_PHYSICAL_USB" => "選擇指定USB後，才能建立實際寫入預覽。",
            "USB_NOT_WRITABLE" => "目前USB不是可寫入、非系統碟的合格目標。",
            "FORMAT_ADAPTER_UNAVAILABLE" => "這個Windows版本無法建立建議的檔案系統；請使用合適平台或另選明確用途。",
            _ => HumanReason(message)
        };
    }
    private string PhaseText(string phase, string state) => phase switch
    {
        "awaiting-administrator" => T("等待Windows管理員授權。", "Waiting for Windows administrator approval."),
        "hashing-source" => T("正在核對來源映像。", "Checking the source image."),
        "reading-physical-prefix" => T("正在從USB讀回映像並計算雜湊。", "Reading the USB image back and hashing it."),
        "formatting-volume" => T("正在格式化；此時不能安全取消。", "Formatting; there is no safe cancellation at this stage."),
        "rebuilding-partition-table" => T("正在建立分割表。", "Rebuilding the partition table."),
        _ => state == "running" || state == "dry-run-running" ? T("核心正在執行；請保留USB連線。", "The core is working; keep the USB connected.") : T("等待核心狀態…", "Waiting for core status…")
    };
    private string ErrorText(string code) => code switch
    {
        "ELEVATION_CANCELLED" => T("已取消管理員授權，未開始寫入。", "Administrator approval was cancelled; no write was started."),
        "DEVICE_CHANGED" or "DEVICE_IDENTITY_CHANGED" => T("USB已變更或重新編號。請重新整理並預覽。", "The USB changed or was renumbered. Refresh and preview again."),
        "DEVICE_NOT_ELIGIBLE" or "INTERNAL_WRITES_UNSUPPORTED" or "SYSTEM_DISK_REFUSED" => T("這個目標不能寫入。只允許已辨識且非系統碟的USB。", "This target is not writable. Only identified non-system USB devices are allowed."),
        "PLAN_EXPIRED" or "PLAN_CHANGED" or "PLAN_ALREADY_USED" => T("預覽已失效，請重新建立。", "The preview is no longer valid; prepare a new one."),
        "CHECKSUM_MISMATCH" or "IMAGE_IDENTITY_CHANGED" => T("映像不符合參考雜湊，請確認檔案與參考值。", "The image does not match the reference hash. Check both values."),
        "INVALID_SHA256" => T("參考SHA-256需為64個十六進位字元；也可以留白只計算檔案雜湊。", "Reference SHA-256 must contain 64 hexadecimal characters; leave it blank to calculate a file hash only."),
        "IMAGE_NOT_FOUND" or "INVALID_IMAGE" or "IMAGE_TYPE_NOT_SUPPORTED" or "RAW_IMAGE_REQUIRED" or "ISO_REQUIRED" => T("無法使用這份映像。請選擇完整的ISO或IMG安裝映像。", "This image cannot be used. Choose a complete ISO or IMG installation image."),
        "REKORDBOX_RUNNING" => T("請先正常關閉所有rekordbox，再執行快照或還原。", "Close all rekordbox processes cleanly before snapshot or restore."),
        "NO_EXPORT_METADATA" => T("沒有找到可備份的匯出資料庫。", "No exported library metadata was found to snapshot."),
        "RESTORE_TARGET_MISMATCH" => T("這份快照屬於另一支USB，不能套用到目前目標。", "This snapshot belongs to different media and cannot be restored here."),
        "CORE_START_FAILED" => T("找不到可用的核心或Node執行環境。請使用完整安裝捷徑。", "The core or Node runtime is unavailable. Use the complete installed application."),
        "USB_BUSY" or "STATE_BUSY" => T("另一個工作正在使用這支USB。請先查詢該工作。", "Another job owns this USB. Check that job first."),
        "LARGE_FAT32_QUICK_REQUIRED" => T("大容量FAT32目前需要勾選快速格式化。", "Large FAT32 currently requires quick formatting."),
        "INVALID_LABEL" => T("USB名稱不符合這個檔案系統的字元或長度限制。", "The volume label exceeds this filesystem's character or length limits."),
        "MODEL_NOT_FOUND" or "INVALID_SMART_INPUT" or "INVALID_SMART_TARGET" => T("設備或判定條件需要重新確認。請重新整理並核對選擇。", "Recheck the equipment and assessment inputs. Refresh and review the selection."),
        "SUBMISSION_UNKNOWN" => T("提交結果尚不明確，請先查詢工作並處理尚未回應的Windows提示；不要重新提交。", "Submission remains uncertain. Check the job and outstanding Windows prompt before any retry."),
        _ => T("核心未完成這次操作。可開啟詳細診斷查看原因；資料不會被當作已完成。", "The core did not complete this operation. Open diagnostics for details; it is not reported as completed.")
    };
    private void ShowError(Exception error, bool dialog)
    { var message = error is ToolkitCliException cli ? ErrorText(cli.Code) : T("操作未完成。請查看詳細診斷。", "The operation did not complete. See diagnostics."); _status.Text = message; if (dialog) MessageBox.Show(this, message, Text, MessageBoxButtons.OK, MessageBoxIcon.Information); }
    private static string Bytes(long count) => count >= 1024L * 1024 * 1024 ? (count / (1024D * 1024 * 1024)).ToString("0.##", CultureInfo.InvariantCulture) + " GiB" : count >= 1024 * 1024 ? (count / (1024D * 1024)).ToString("0.##", CultureInfo.InvariantCulture) + " MiB" : count.ToString(CultureInfo.InvariantCulture) + " B";

    private void ShowTextDialog(string title, string content, bool copy = true)
    {
        using var dialog = new Form { Text = title, StartPosition = FormStartPosition.CenterParent, Size = new Size(760, 520), MinimumSize = new Size(600, 400), ShowInTaskbar = false };
        var panel = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(16), ColumnCount = 1, RowCount = 2 }; panel.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); panel.RowStyles.Add(new RowStyle(SizeType.AutoSize)); var text = ReadonlyText(); text.Text = content; panel.Controls.Add(text, 0, 0);
        var close = new Button { Text = T("關閉", "Close"), AutoSize = true, MinimumSize = new Size(90, 36), DialogResult = DialogResult.Cancel }; var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft }; buttons.Controls.Add(close);
        if (copy) { var copyButton = new Button { Text = T("複製內容", "Copy"), AutoSize = true, MinimumSize = new Size(110, 36) }; copyButton.Click += (_, _) => { try { Clipboard.SetText(content); copyButton.Text = T("已複製", "Copied"); } catch { copyButton.Text = T("稍後重試", "Try again"); } }; buttons.Controls.Add(copyButton); }
        panel.Controls.Add(buttons, 0, 1); dialog.Controls.Add(panel); dialog.CancelButton = close; dialog.ShowDialog(this);
    }
    private void ShowDiagnostics() => ShowTextDialog(T("詳細診斷（本機）", "Local diagnostics"), _client.LastDiagnostics.Length > 0 ? _client.LastDiagnostics : T("目前沒有錯誤診斷。", "No diagnostics are available yet."));
    private void ShowSources() => ShowTextDialog(T("官方依據", "Official sources"), string.Join("\r\n\r\n", _sourceUrls.Distinct()));
    private void ShowAiPrompt() => ShowTextDialog(T("複製AI接入提示", "Copy AI connection prompt"), _english
        ? "Use HuaiDJ Disk Toolkit through the local MCP server named huaidj-rufus, or the installed huaidj-disk CLI. Start with read-only device inventory and identify the intended USB by its stable identity and capacity. Ask for exact DJ model, firmware, preparation hosts and file-size requirements before recommending a filesystem/library format. Prepare a target-bound plan and explain its erase scope before executing an authorized write. Poll job status; launch, completion, readback equality and hardware acceptance are separate results. Never disable UAC or create an unrestricted elevated service. If the MCP is unavailable, use setup-mcp preview for the actual client and show the proposed setup before applying it."
        : "請透過本機名為 huaidj-rufus 的 MCP，或已安裝的 huaidj-disk CLI 使用 HuaiDJ 磁碟工具箱。先唯讀列出裝置，以固定識別碼與容量確認指定USB。推薦格式前，確認DJ型號、韌體、整理平台與單檔大小；缺資訊保持未知。先建立綁定實體目標的預覽，說明清除範圍，再執行使用者已授權的寫入。持續查詢工作；啟動、完成、讀回雜湊與硬體驗收分開報告。不要停用UAC或建立無限制的提權常駐程式。若找不到MCP，先針對實際client預覽setup-mcp，列出具體設定後再套用。");
}
