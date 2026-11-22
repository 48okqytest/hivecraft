using System.ComponentModel;
using System.Windows.Media;

namespace Hivecraft;

class Notify : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;
    protected void Changed() => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(string.Empty));
    protected void Changed(string n) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(n));
}

class AgentEntry : Notify
{
    string _name = "";
    public string Name { get => _name; set { _name = value; Changed(nameof(Name)); } }
    string _persona = "";
    public string Persona { get => _persona; set { _persona = value ?? ""; Changed(nameof(Persona)); } }
}

class BotRow : Notify
{
    static SolidColorBrush B(string hex) { var b = (SolidColorBrush)new BrushConverter().ConvertFromString(hex)!; b.Freeze(); return b; }
    static readonly Brush Green = B("#4ADE80"), Grey = B("#4B5567"), Red = B("#FB5D6D"), Amber = B("#FFB547"), Dim = B("#7C8799"), Text = B("#D7DEE9");

    public string Name { get; set; } = "";
    public bool Online { get; private set; }
    public double Hp { get; private set; }
    public double Food { get; private set; }
    public string Action { get; private set; } = "";
    public string Thought { get; private set; } = "";
    public Brush DotBrush => Online ? Green : Grey;
    public Brush HpBrush => Hp <= 6 ? Red : Hp <= 12 ? Amber : Green;
    public string HpText => Online ? $"HP {Hp:0}" : "HP –";
    public string FoodText => Online ? $"FOOD {Food:0}" : "FOOD –";
    public Brush ActionBrush => Online ? (Action == "idle" ? Dim : Text) : Grey;

    public void Update(bool online, double hp, double food, string? action, string? thought)
    {
        Online = online; Hp = online ? hp : 0; Food = online ? food : 0;
        Action = !online ? "offline" : string.IsNullOrEmpty(action) ? "idle" : action;
        Thought = thought ?? "";
        Changed();
    }
}

class ChatMsg
{
    static readonly string[] Palette = { "#4CC9F0", "#B794F6", "#4ADE80", "#F59E6B", "#F472B6", "#E5E94B", "#60A5FA", "#2DD4BF" };
    public long Id { get; set; }
    public string From { get; set; } = "";
    public string To { get; set; } = "";
    public string Text { get; set; } = "";
    public string Time { get; set; } = "";
    public string ToSuffix => string.IsNullOrEmpty(To) || To == "all" ? "" : "  → " + To;
    public Brush FromBrush
    {
        get
        {
            string hex = From.Equals(Settings.HumanName, StringComparison.OrdinalIgnoreCase) ? "#FFB547"
                : From == "system" ? "#4B5567"
                : Palette[(int)((uint)StableHash(From) % Palette.Length)];
            var b = (SolidColorBrush)new BrushConverter().ConvertFromString(hex)!; b.Freeze(); return b;
        }
    }
    static int StableHash(string s) { int h = 17; foreach (var c in s) h = h * 31 + c; return h & 0x7fffffff; }
}
