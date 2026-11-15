using System.Globalization;
using System.Text.Json;

namespace HuaiDJ.DiskToolkit.Desktop;

internal static class JsonValue
{
    public static JsonElement Property(this JsonElement element, string name) => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var result) ? result : default;
    public static bool Has(this JsonElement element, string name) => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out _);
    public static string String(this JsonElement element, string name, string fallback = "") => element.Property(name).Text(fallback);
    public static string Text(this JsonElement element, string fallback = "") => element.ValueKind switch
    {
        JsonValueKind.String => element.GetString() ?? fallback,
        JsonValueKind.Number => element.GetRawText(),
        JsonValueKind.True => "true", JsonValueKind.False => "false", _ => fallback
    };
    public static long Long(this JsonElement element, string name, long fallback = 0)
    {
        var value = element.Property(name);
        return value.TryNumber(out var result) ? result : fallback;
    }
    public static bool TryNumber(this JsonElement element, out long value)
    {
        if (element.ValueKind == JsonValueKind.Number && element.TryGetInt64(out value)) return true;
        if (element.ValueKind == JsonValueKind.String && long.TryParse(element.GetString(), CultureInfo.InvariantCulture, out value)) return true;
        value = 0; return false;
    }
    public static bool Bool(this JsonElement element, string name, bool fallback = false) => element.Property(name).ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => fallback };
    public static IEnumerable<JsonElement> Array(this JsonElement element, string name) => element.Property(name).Items();
    public static IEnumerable<JsonElement> Items(this JsonElement element) => element.ValueKind == JsonValueKind.Array ? element.EnumerateArray().ToArray() : [];
    public static IEnumerable<string> Strings(this JsonElement element, string name) => element.Array(name).Select(value => value.Text()).Where(value => value.Length > 0);
}
