// Screen control - the Windows side. Compiled at run time by PowerShell (Add-Type), so Cockpit
// needs no native module. screen-control.js starts ONE PowerShell, sends this source as the
// first stdin line (base64), then one JSON command per line; every answer is one JSON line.
//
// Everything works in PHYSICAL pixels of the virtual desktop: each command first makes its
// thread per-monitor DPI aware (v2). powershell.exe may carry a DPI setting of its own in its
// manifest, which a process-wide call cannot change - the per-thread one always applies.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Automation;
using System.Web.Script.Serialization;

public static class CockpitScreen
{
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct MONITORINFOEX
    {
        public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public INPUTUNION u; }

    delegate bool MonitorEnumProc(IntPtr hMon, IntPtr hdc, ref RECT r, IntPtr data);
    delegate bool EnumWindowsProc(IntPtr h, IntPtr data);

    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr hMon, ref MONITORINFOEX mi);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern short VkKeyScan(char c);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT val, int size);

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_LEFTDOWN = 0x2, MOUSEEVENTF_LEFTUP = 0x4, MOUSEEVENTF_RIGHTDOWN = 0x8, MOUSEEVENTF_RIGHTUP = 0x10,
        MOUSEEVENTF_MIDDLEDOWN = 0x20, MOUSEEVENTF_MIDDLEUP = 0x40, MOUSEEVENTF_WHEEL = 0x800, MOUSEEVENTF_HWHEEL = 0x1000;
    const uint KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4, KEYEVENTF_EXTENDEDKEY = 0x1;

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

    // ---- the one entry point: a JSON command in, a JSON answer out ----
    public static string Handle(string line)
    {
        object id = null;
        try
        {
            SetThreadDpiAwarenessContext(new IntPtr(-4)); // PER_MONITOR_AWARE_V2
            var m = Json.Deserialize<Dictionary<string, object>>(line);
            m.TryGetValue("id", out id);
            string op = Str(m, "op");
            object result;
            switch (op)
            {
                case "monitors": result = Monitors(); break;
                case "capture": result = Capture(Int(m, "x"), Int(m, "y"), Int(m, "w"), Int(m, "h"), Int(m, "cell")); break;
                case "grid": result = GridOf(Int(m, "x"), Int(m, "y"), Int(m, "w"), Int(m, "h"), Int(m, "cell")); break;
                case "ocr": result = Ocr(Int(m, "x"), Int(m, "y"), Int(m, "w"), Int(m, "h")); break;
                case "ui": result = UiList(Long(m, "handle"), Int(m, "max"), Str(m, "offscreen") == "True", Str(m, "filter"), Math.Max(500, Int(m, "budget"))); break;
                case "uiAct": result = UiAct(Int(m, "snap"), Int(m, "idx"), Str(m, "action"), Str(m, "value")); break;
                case "cursor": { POINT p; GetCursorPos(out p); result = new Dictionary<string, object> { { "x", p.X }, { "y", p.Y } }; break; }
                case "move": SetCursorPos(Int(m, "x"), Int(m, "y")); result = true; break;
                case "click": Click(Int(m, "x"), Int(m, "y"), Str(m, "button"), Math.Max(1, Int(m, "count"))); result = true; break;
                case "drag": Drag(Int(m, "x"), Int(m, "y"), Int(m, "x2"), Int(m, "y2")); result = true; break;
                case "scroll": Scroll(Int(m, "x"), Int(m, "y"), Int(m, "dx"), Int(m, "dy")); result = true; break;
                case "type": TypeText(Str(m, "text")); result = true; break;
                case "key": Key(Str(m, "combo")); result = true; break;
                case "windows": result = Windows(); break;
                case "focus": result = Focus(new IntPtr(Long(m, "handle"))); break;
                case "launch": Process.Start(new ProcessStartInfo(Str(m, "target")) { UseShellExecute = true }); result = true; break;
                case "ownerAt": result = OwnerPid(WindowAt(Int(m, "x"), Int(m, "y"))); break;
                case "foregroundPid": result = OwnerPid(GetForegroundWindow()); break;
                default: throw new Exception("unknown op " + op);
            }
            return Ascii(Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "result", result } }));
        }
        catch (Exception e)
        {
            return Ascii(Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", e.Message } }));
        }
    }

    // Answers travel as plain ASCII (\u escapes), so the console code page can never mangle a title.
    static string Ascii(string s)
    {
        var b = new StringBuilder(s.Length + 16);
        foreach (char c in s) { if (c < 128) b.Append(c); else b.Append("\\u").Append(((int)c).ToString("x4")); }
        return b.ToString();
    }
    static string Str(Dictionary<string, object> m, string k) { object v; return m.TryGetValue(k, out v) && v != null ? v.ToString() : ""; }
    static int Int(Dictionary<string, object> m, string k) { object v; return m.TryGetValue(k, out v) && v != null ? Convert.ToInt32(v) : 0; }
    static long Long(Dictionary<string, object> m, string k) { object v; return m.TryGetValue(k, out v) && v != null ? Convert.ToInt64(v) : 0; }

    // ---- looking ----
    static List<object> Monitors()
    {
        var list = new List<object>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr h, IntPtr dc, ref RECT r, IntPtr d)
        {
            var mi = new MONITORINFOEX(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            GetMonitorInfo(h, ref mi);
            list.Add(new Dictionary<string, object> {
                { "x", mi.rcMonitor.L }, { "y", mi.rcMonitor.T },
                { "w", mi.rcMonitor.R - mi.rcMonitor.L }, { "h", mi.rcMonitor.B - mi.rcMonitor.T },
                { "primary", (mi.dwFlags & 1) != 0 }, { "name", mi.szDevice } });
            return true;
        }, IntPtr.Zero);
        return list;
    }
    static Bitmap Grab(int x, int y, int w, int h)
    {
        if (w <= 0 || h <= 0 || w > 16384 || h > 16384) throw new Exception("bad capture size");
        var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
        using (var g = Graphics.FromImage(bmp))
            g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy); // .NET refuses SourceCopy|CaptureBlt
        return bmp;
    }
    static Dictionary<string, object> Capture(int x, int y, int w, int h, int cell)
    {
        using (var bmp = Grab(x, y, w, h))
        using (var ms = new MemoryStream())
        {
            bmp.Save(ms, ImageFormat.Png);
            var r = new Dictionary<string, object> { { "w", w }, { "h", h }, { "png", Convert.ToBase64String(ms.ToArray()) } };
            if (cell > 0) r["grid"] = Grid(bmp, cell); // the same pixels, for "what changed" later
            return r;
        }
    }
    static Dictionary<string, object> GridOf(int x, int y, int w, int h, int cell)
    {
        using (var bmp = Grab(x, y, w, h)) return Grid(bmp, Math.Max(4, cell));
    }
    // The brightness of each cell x cell square: a cheap fingerprint to compare two moments by.
    static Dictionary<string, object> Grid(Bitmap bmp, int cell)
    {
        int w = bmp.Width, h = bmp.Height, cols = (w + cell - 1) / cell, rows = (h + cell - 1) / cell;
        var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        var buf = new byte[data.Stride * h];
        Marshal.Copy(data.Scan0, buf, 0, buf.Length);
        int stride = data.Stride;
        bmp.UnlockBits(data);
        var sum = new long[cols * rows];
        var cnt = new int[cols * rows];
        for (int y = 0; y < h; y++)
        {
            int row = (y / cell) * cols, o = y * stride;
            for (int x = 0; x < w; x++, o += 3)
            {
                int i = row + x / cell;
                sum[i] += (buf[o] * 29 + buf[o + 1] * 150 + buf[o + 2] * 77) >> 8; // BGR -> luminance
                cnt[i]++;
            }
        }
        var v = new int[cols * rows];
        for (int i = 0; i < v.Length; i++) v[i] = cnt[i] > 0 ? (int)(sum[i] / cnt[i]) : 0;
        return new Dictionary<string, object> { { "cols", cols }, { "rows", rows }, { "cell", cell }, { "v", v } };
    }

    // ---- reading text: Windows' own OCR (Windows.Media.Ocr), reached by reflection ----
    // Add-Type compiles against .NET Framework without the WinRT metadata, so the WinRT types are
    // looked up by name (the way PowerShell itself does) and their async calls awaited via AsTask.
    static Assembly RtInterop;
    static MethodInfo AsTaskOp;
    static Type Rt(string name)
    {
        foreach (var asm in new[] { "Windows.Foundation", "Windows.Graphics", "Windows.Media" })
        {
            var t = Type.GetType(name + ", " + asm + ", ContentType=WindowsRuntime", false);
            if (t != null) return t;
        }
        throw new Exception("text recognition is not available on this Windows (" + name + ")");
    }
    static object Await(object op, Type resultType)
    {
        if (AsTaskOp == null)
        {
            RtInterop = Assembly.Load("System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089");
            foreach (var mi in RtInterop.GetType("System.WindowsRuntimeSystemExtensions").GetMethods())
                if (mi.Name == "AsTask" && mi.IsGenericMethod && mi.GetParameters().Length == 1 && mi.GetParameters()[0].ParameterType.Name == "IAsyncOperation`1") { AsTaskOp = mi; break; }
        }
        var task = (Task)AsTaskOp.MakeGenericMethod(resultType).Invoke(null, new object[] { op });
        if (!task.Wait(15000)) throw new Exception("text recognition took too long");
        return task.GetType().GetProperty("Result").GetValue(task, null);
    }
    static object P(object o, Type t, string name) { return t.GetProperty(name).GetValue(o, null); }
    static MethodInfo M(Type t, string name, int args)
    {
        foreach (var mi in t.GetMethods()) if (mi.Name == name && mi.GetParameters().Length == args) return mi;
        throw new Exception("no " + t.Name + "." + name);
    }
    static Dictionary<string, object> Ocr(int x, int y, int w, int h)
    {
        var engT = Rt("Windows.Media.Ocr.OcrEngine");
        var eng = M(engT, "TryCreateFromUserProfileLanguages", 0).Invoke(null, null);
        if (eng == null) throw new Exception("no OCR language is installed (Windows Settings > Time & language > Language)");
        int maxDim = Convert.ToInt32(engT.GetProperty("MaxImageDimension").GetValue(null, null));
        // small UI text reads far better at twice the size
        int up = (w * 2 <= maxDim && h * 2 <= maxDim && (long)w * h <= 2500000) ? 2 : 1;
        if (w > maxDim || h > maxDim) throw new Exception("the area is larger than " + maxDim + " pixels - read a smaller part");
        byte[] png;
        using (var bmp = Grab(x, y, w, h))
        using (var big = new Bitmap(w * up, h * up, PixelFormat.Format24bppRgb))
        using (var ms = new MemoryStream())
        {
            using (var g = Graphics.FromImage(big))
            {
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.DrawImage(bmp, 0, 0, w * up, h * up);
            }
            big.Save(ms, ImageFormat.Png);
            png = ms.ToArray();
        }
        if (RtInterop == null)
            RtInterop = Assembly.Load("System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089");
        var streamExt = RtInterop.GetType("System.IO.WindowsRuntimeStreamExtensions");
        var ras = streamExt.GetMethod("AsRandomAccessStream", new[] { typeof(Stream) }).Invoke(null, new object[] { new MemoryStream(png) });
        var decT = Rt("Windows.Graphics.Imaging.BitmapDecoder");
        var dec = Await(M(decT, "CreateAsync", 1).Invoke(null, new[] { ras }), decT);
        var sbT = Rt("Windows.Graphics.Imaging.SoftwareBitmap");
        var sb = Await(M(decT, "GetSoftwareBitmapAsync", 0).Invoke(dec, null), sbT);
        var resT = Rt("Windows.Media.Ocr.OcrResult");
        var res = Await(M(engT, "RecognizeAsync", 1).Invoke(eng, new[] { sb }), resT);
        var lineT = Rt("Windows.Media.Ocr.OcrLine");
        var wordT = Rt("Windows.Media.Ocr.OcrWord");
        var lines = new List<object>();
        foreach (object line in (IEnumerable)P(res, resT, "Lines"))
        {
            double l = double.MaxValue, t = double.MaxValue, r = double.MinValue, b = double.MinValue;
            var words = new List<object>();
            foreach (object word in (IEnumerable)P(line, lineT, "Words"))
            {
                object br = P(word, wordT, "BoundingRect");
                var bt = br.GetType();
                double wx = Convert.ToDouble(P(br, bt, "X")) / up, wy = Convert.ToDouble(P(br, bt, "Y")) / up;
                double ww = Convert.ToDouble(P(br, bt, "Width")) / up, wh = Convert.ToDouble(P(br, bt, "Height")) / up;
                l = Math.Min(l, wx); t = Math.Min(t, wy); r = Math.Max(r, wx + ww); b = Math.Max(b, wy + wh);
                words.Add(new Dictionary<string, object> { { "t", (string)P(word, wordT, "Text") },
                    { "x", x + (int)Math.Round(wx) }, { "y", y + (int)Math.Round(wy) }, { "w", (int)Math.Round(ww) }, { "h", (int)Math.Round(wh) } });
            }
            if (words.Count == 0) continue;
            lines.Add(new Dictionary<string, object> { { "text", (string)P(line, lineT, "Text") },
                { "x", x + (int)Math.Round(l) }, { "y", y + (int)Math.Round(t) }, { "w", (int)Math.Round(r - l) }, { "h", (int)Math.Round(b - t) }, { "words", words } });
        }
        string lang = "";
        try { var lg = engT.GetProperty("RecognizerLanguage").GetValue(eng, null); lang = (string)lg.GetType().GetProperty("LanguageTag").GetValue(lg, null); } catch { }
        return new Dictionary<string, object> { { "lines", lines }, { "lang", lang } };
    }

    // ---- the controls of a window: UI Automation ----
    // One walk of the control view with a cache request (one cross-process round trip per element,
    // not one per property), cut by a time and a count budget - a browser page can hold thousands.
    // The elements are kept per listing ("snap") so a later action can use them without a search.
    static readonly Dictionary<int, List<AutomationElement>> UiSnaps = new Dictionary<int, List<AutomationElement>>();
    static int UiSnapN = 0;
    static readonly AutomationProperty[] UiProps = {
        AutomationElement.NameProperty, AutomationElement.ControlTypeProperty, AutomationElement.AutomationIdProperty,
        AutomationElement.BoundingRectangleProperty, AutomationElement.IsEnabledProperty, AutomationElement.IsOffscreenProperty,
        AutomationElement.HasKeyboardFocusProperty, AutomationElement.IsPasswordProperty, AutomationElement.ProcessIdProperty,
        AutomationElement.IsInvokePatternAvailableProperty, AutomationElement.IsValuePatternAvailableProperty,
        AutomationElement.IsTogglePatternAvailableProperty, AutomationElement.IsSelectionItemPatternAvailableProperty,
        AutomationElement.IsExpandCollapsePatternAvailableProperty, AutomationElement.IsScrollItemPatternAvailableProperty,
        ValuePattern.ValueProperty, ValuePattern.IsReadOnlyProperty, TogglePattern.ToggleStateProperty,
        ExpandCollapsePattern.ExpandCollapseStateProperty, SelectionItemPattern.IsSelectedProperty };
    static object Cached(AutomationElement e, AutomationProperty p)
    {
        try { var v = e.GetCachedPropertyValue(p, true); return v == AutomationElement.NotSupported ? null : v; } catch { return null; }
    }
    static bool Flag(AutomationElement e, AutomationProperty p) { var v = Cached(e, p); return v is bool && (bool)v; }
    static Dictionary<string, object> UiList(long handle, int max, bool offscreen, string filter, int budgetMs)
    {
        if (max <= 0) max = 150;
        var root = AutomationElement.FromHandle(new IntPtr(handle));
        var cr = new CacheRequest();
        foreach (var p in UiProps) cr.Add(p);
        cr.TreeFilter = Automation.ControlViewCondition;
        var walker = new TreeWalker(Automation.ControlViewCondition);
        var kept = new List<AutomationElement>();
        var items = new List<object>();
        string f = (filter ?? "").ToLowerInvariant();
        var sw = Stopwatch.StartNew();
        int visited = 0;
        bool cut = false;
        var stack = new Stack<KeyValuePair<AutomationElement, int>>();
        using (cr.Activate())
        {
            stack.Push(new KeyValuePair<AutomationElement, int>(root.GetUpdatedCache(cr), 0));
            while (stack.Count > 0)
            {
                if (sw.ElapsedMilliseconds > budgetMs || visited >= 5000 || items.Count >= max) { cut = true; break; }
                var kv = stack.Pop();
                var el = kv.Key;
                visited++;
                bool off = Flag(el, AutomationElement.IsOffscreenProperty);
                if (kv.Value > 0 && (offscreen || !off))
                {
                    var item = UiItem(el, kept.Count, kv.Value);
                    if (item != null && (f == "" || ((string)item["_find"]).Contains(f)))
                    {
                        item.Remove("_find");
                        kept.Add(el);
                        items.Add(item);
                    }
                }
                if (off && !offscreen && kv.Value > 0) continue; // a hidden branch (closed menu, scrolled away)
                var kids = new List<AutomationElement>();
                try
                {
                    var c = walker.GetFirstChild(el, cr);
                    while (c != null && kids.Count < 2000) { kids.Add(c); c = walker.GetNextSibling(c, cr); }
                }
                catch { }
                for (int i = kids.Count - 1; i >= 0; i--) stack.Push(new KeyValuePair<AutomationElement, int>(kids[i], kv.Value + 1));
            }
        }
        int snap = ++UiSnapN;
        UiSnaps[snap] = kept;
        UiSnaps.Remove(snap - 8); // the last eight listings stay usable
        return new Dictionary<string, object> { { "snap", snap }, { "items", items }, { "cut", cut }, { "visited", visited }, { "ms", sw.ElapsedMilliseconds } };
    }
    static Dictionary<string, object> UiItem(AutomationElement el, int idx, int depth)
    {
        string name = (Cached(el, AutomationElement.NameProperty) as string ?? "").Trim();
        var ct = Cached(el, AutomationElement.ControlTypeProperty) as ControlType;
        string type = ct == null ? "?" : ct.ProgrammaticName.Replace("ControlType.", "");
        object rv = Cached(el, AutomationElement.BoundingRectangleProperty);
        if (!(rv is System.Windows.Rect)) return null;
        var rc = (System.Windows.Rect)rv;
        if (rc.IsEmpty || rc.Width < 1 || rc.Height < 1) return null;
        var acts = new List<string>();
        if (Flag(el, AutomationElement.IsInvokePatternAvailableProperty)) acts.Add("invoke");
        if (Flag(el, AutomationElement.IsTogglePatternAvailableProperty)) acts.Add("toggle");
        if (Flag(el, AutomationElement.IsSelectionItemPatternAvailableProperty)) acts.Add("select");
        if (Flag(el, AutomationElement.IsExpandCollapsePatternAvailableProperty)) acts.Add("expand");
        bool hasValue = Flag(el, AutomationElement.IsValuePatternAvailableProperty);
        bool password = Flag(el, AutomationElement.IsPasswordProperty);
        string value = null;
        if (hasValue)
        {
            if (!Flag(el, ValuePattern.IsReadOnlyProperty)) acts.Add("set_value");
            if (!password) value = Cached(el, ValuePattern.ValueProperty) as string; // never a password's
        }
        if (Flag(el, AutomationElement.IsScrollItemPatternAvailableProperty)) acts.Add("show");
        string aid = Cached(el, AutomationElement.AutomationIdProperty) as string ?? "";
        bool worth = acts.Count > 0 || !string.IsNullOrEmpty(value) || (name != "" && type != "Pane");
        if (!worth) return null;
        var it = new Dictionary<string, object> {
            { "i", idx }, { "type", type }, { "name", name.Length > 150 ? name.Substring(0, 150) + "..." : name },
            { "x", (int)Math.Round(rc.X) }, { "y", (int)Math.Round(rc.Y) }, { "w", (int)Math.Round(rc.Width) }, { "h", (int)Math.Round(rc.Height) },
            { "depth", depth }, { "actions", acts }, { "pid", Cached(el, AutomationElement.ProcessIdProperty) ?? 0 } };
        if (aid != "" && aid.Length <= 80) it["aid"] = aid;
        if (value != null) it["value"] = value.Length > 300 ? value.Substring(0, 300) + "..." : value;
        if (password) it["password"] = true;
        if (!Flag(el, AutomationElement.IsEnabledProperty)) it["disabled"] = true;
        if (Flag(el, AutomationElement.HasKeyboardFocusProperty)) it["focused"] = true;
        var ts = Cached(el, TogglePattern.ToggleStateProperty);
        if (ts != null) it["state"] = ts.ToString().ToLowerInvariant();
        var es = Cached(el, ExpandCollapsePattern.ExpandCollapseStateProperty);
        if (es != null && !it.ContainsKey("state")) it["state"] = es.ToString().ToLowerInvariant();
        if (Flag(el, SelectionItemPattern.IsSelectedProperty)) it["selected"] = true;
        it["_find"] = (name + "\n" + aid + "\n" + type + "\n" + (value ?? "")).ToLowerInvariant();
        return it;
    }
    // An action on an element of a listing. Patterns first (they need no mouse and work on a covered
    // window); when an element has none, the answer asks main for a real click / typing instead,
    // which then goes through the same guards as any click.
    static Dictionary<string, object> UiAct(int snap, int idx, string action, string value)
    {
        List<AutomationElement> list;
        if (!UiSnaps.TryGetValue(snap, out list) || idx < 0 || idx >= list.Count) throw new Exception("that element list is old - call ui_elements again");
        var el = list[idx];
        var r = new Dictionary<string, object>();
        object pat;
        try
        {
            switch (action)
            {
                case "click":
                    if (el.TryGetCurrentPattern(InvokePattern.Pattern, out pat)) r["done"] = Bounded(() => ((InvokePattern)pat).Invoke()) ? "invoked" : "invoked (it is still busy - probably a dialog opened)";
                    else if (el.TryGetCurrentPattern(TogglePattern.Pattern, out pat)) { ((TogglePattern)pat).Toggle(); r["done"] = "toggled, now " + ((TogglePattern)pat).Current.ToggleState.ToString().ToLowerInvariant(); }
                    else if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat)) { ((SelectionItemPattern)pat).Select(); r["done"] = "selected"; }
                    else if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pat))
                    {
                        var ec = (ExpandCollapsePattern)pat;
                        if (ec.Current.ExpandCollapseState == ExpandCollapseState.Expanded) { ec.Collapse(); r["done"] = "collapsed"; } else { ec.Expand(); r["done"] = "expanded"; }
                    }
                    else r["needMouse"] = true;
                    break;
                case "toggle":
                    if (!el.TryGetCurrentPattern(TogglePattern.Pattern, out pat)) throw new Exception("it cannot be toggled");
                    ((TogglePattern)pat).Toggle(); r["done"] = "toggled, now " + ((TogglePattern)pat).Current.ToggleState.ToString().ToLowerInvariant();
                    break;
                case "select":
                    if (!el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat)) throw new Exception("it cannot be selected");
                    ((SelectionItemPattern)pat).Select(); r["done"] = "selected";
                    break;
                case "expand":
                case "collapse":
                    if (!el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pat)) throw new Exception("it cannot be expanded or collapsed");
                    if (action == "expand") ((ExpandCollapsePattern)pat).Expand(); else ((ExpandCollapsePattern)pat).Collapse();
                    r["done"] = action == "expand" ? "expanded" : "collapsed";
                    break;
                case "show":
                    if (!el.TryGetCurrentPattern(ScrollItemPattern.Pattern, out pat)) throw new Exception("it cannot be scrolled into view");
                    ((ScrollItemPattern)pat).ScrollIntoView(); r["done"] = "scrolled into view";
                    break;
                case "focus":
                    el.SetFocus(); r["done"] = "focused";
                    break;
                case "set_value":
                    if (el.TryGetCurrentPattern(ValuePattern.Pattern, out pat) && !((ValuePattern)pat).Current.IsReadOnly)
                    {
                        ((ValuePattern)pat).SetValue(value ?? ""); r["done"] = "value set";
                    }
                    else { el.SetFocus(); r["needType"] = true; }
                    break;
                default: throw new Exception("unknown action \"" + action + "\"");
            }
            var rc = el.Current.BoundingRectangle;
            if (!rc.IsEmpty) { r["x"] = (int)Math.Round(rc.X + rc.Width / 2); r["y"] = (int)Math.Round(rc.Y + rc.Height / 2); }
            r["pid"] = el.Current.ProcessId;
        }
        catch (ElementNotAvailableException) { throw new Exception("that element is gone - call ui_elements again"); }
        return r;
    }
    // InvokePattern.Invoke waits for a modal dialog that the button opens; never hang the helper on it.
    static bool Bounded(Action a)
    {
        Exception err = null;
        var t = new Thread(() => { try { a(); } catch (Exception e) { err = e; } });
        t.IsBackground = true;
        t.Start();
        if (!t.Join(3000)) return false;
        if (err != null) throw err;
        return true;
    }

    // ---- the mouse ----
    static INPUT MouseIn(uint flags, uint data) { var i = new INPUT { type = INPUT_MOUSE }; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i; }
    static void Send(params INPUT[] ins) { if (ins.Length > 0) SendInput((uint)ins.Length, ins, Marshal.SizeOf(typeof(INPUT))); }
    static void Click(int x, int y, string button, int count)
    {
        SetCursorPos(x, y);
        Thread.Sleep(30);
        uint down = MOUSEEVENTF_LEFTDOWN, up = MOUSEEVENTF_LEFTUP;
        if (button == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
        else if (button == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
        for (int i = 0; i < Math.Min(count, 3); i++)
        {
            Send(MouseIn(down, 0), MouseIn(up, 0));
            if (i + 1 < count) Thread.Sleep(60);
        }
    }
    static void Drag(int x, int y, int x2, int y2)
    {
        SetCursorPos(x, y);
        Thread.Sleep(40);
        Send(MouseIn(MOUSEEVENTF_LEFTDOWN, 0));
        int steps = 12;
        for (int i = 1; i <= steps; i++)
        {
            SetCursorPos(x + (x2 - x) * i / steps, y + (y2 - y) * i / steps);
            Thread.Sleep(15);
        }
        Thread.Sleep(40);
        Send(MouseIn(MOUSEEVENTF_LEFTUP, 0));
    }
    static void Scroll(int x, int y, int dx, int dy)
    {
        SetCursorPos(x, y);
        Thread.Sleep(20);
        // dy > 0 = scroll down (content moves up), like a wheel turned toward you; one unit = one notch
        if (dy != 0) Send(MouseIn(MOUSEEVENTF_WHEEL, unchecked((uint)(-dy * 120))));
        if (dx != 0) Send(MouseIn(MOUSEEVENTF_HWHEEL, unchecked((uint)(dx * 120))));
    }

    // ---- the keyboard ----
    static INPUT KeyIn(ushort vk, ushort scan, uint flags) { var i = new INPUT { type = INPUT_KEYBOARD }; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
    static void TypeText(string text)
    {
        foreach (char c in text)
        {
            if (c == '\r') continue;
            if (c == '\n') { Send(KeyIn(0x0D, 0, 0), KeyIn(0x0D, 0, KEYEVENTF_KEYUP)); }
            else if (c == '\t') { Send(KeyIn(0x09, 0, 0), KeyIn(0x09, 0, KEYEVENTF_KEYUP)); }
            else Send(KeyIn(0, c, KEYEVENTF_UNICODE), KeyIn(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
            Thread.Sleep(4);
        }
    }
    static readonly Dictionary<string, ushort> Named = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
        { "enter", 0x0D }, { "return", 0x0D }, { "esc", 0x1B }, { "escape", 0x1B }, { "tab", 0x09 }, { "space", 0x20 },
        { "backspace", 0x08 }, { "delete", 0x2E }, { "del", 0x2E }, { "insert", 0x2D }, { "home", 0x24 }, { "end", 0x23 },
        { "pageup", 0x21 }, { "pagedown", 0x22 }, { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 },
        { "printscreen", 0x2C }, { "capslock", 0x14 }, { "menu", 0x5D }, { "apps", 0x5D },
        { "volumeup", 0xAF }, { "volumedown", 0xAE }, { "volumemute", 0xAD } };
    static readonly HashSet<ushort> Extended = new HashSet<ushort> { 0x2E, 0x2D, 0x24, 0x23, 0x21, 0x22, 0x26, 0x28, 0x25, 0x27, 0x5B, 0x5C, 0x5D, 0xA3, 0xA5 };
    static ushort VkOf(string k)
    {
        ushort vk;
        if (Named.TryGetValue(k, out vk)) return vk;
        if (k.Length > 1 && (k[0] == 'f' || k[0] == 'F'))
        {
            int n; if (int.TryParse(k.Substring(1), out n) && n >= 1 && n <= 24) return (ushort)(0x6F + n);
        }
        if (k.Length == 1)
        {
            char c = k[0];
            if (c >= 'a' && c <= 'z') return (ushort)(c - 32);
            if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c;
            short s = VkKeyScan(c);
            if (s != -1) return (ushort)(s & 0xff);
        }
        throw new Exception("unknown key \"" + k + "\"");
    }
    static void Key(string combo)
    {
        var mods = new List<ushort>();
        ushort main = 0;
        foreach (var raw in combo.Split('+'))
        {
            string k = raw.Trim();
            if (k == "" && combo.EndsWith("+")) k = "+";
            if (k == "") continue;
            string l = k.ToLowerInvariant();
            if (l == "ctrl" || l == "control") mods.Add(0xA2);
            else if (l == "shift") mods.Add(0xA0);
            else if (l == "alt" || l == "option") mods.Add(0xA4);
            else if (l == "win" || l == "windows" || l == "meta" || l == "cmd" || l == "super") mods.Add(0x5B);
            else if (main != 0) throw new Exception("two keys in \"" + combo + "\" - one key plus modifiers");
            else main = VkOf(k);
        }
        var ins = new List<INPUT>();
        foreach (var m in mods) ins.Add(KeyIn(m, 0, Extended.Contains(m) ? KEYEVENTF_EXTENDEDKEY : 0));
        if (main != 0)
        {
            uint ext = Extended.Contains(main) ? KEYEVENTF_EXTENDEDKEY : 0;
            ins.Add(KeyIn(main, 0, ext));
            ins.Add(KeyIn(main, 0, ext | KEYEVENTF_KEYUP));
        }
        for (int i = mods.Count - 1; i >= 0; i--) ins.Add(KeyIn(mods[i], 0, (Extended.Contains(mods[i]) ? KEYEVENTF_EXTENDEDKEY : 0) | KEYEVENTF_KEYUP));
        Send(ins.ToArray());
    }

    // ---- windows and apps ----
    static List<object> Windows()
    {
        var list = new List<object>();
        IntPtr fg = GetForegroundWindow();
        EnumWindows(delegate (IntPtr h, IntPtr d)
        {
            if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true; // hidden, or owned by another
            if ((GetWindowLong(h, -20) & 0x80) != 0) return true; // WS_EX_TOOLWINDOW
            int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true; // a parked app
            int len = GetWindowTextLength(h);
            if (len <= 0) return true;
            var sb = new StringBuilder(len + 1); GetWindowText(h, sb, sb.Capacity);
            // the visible frame: GetWindowRect adds the invisible resize border (about 7 px a side on 10/11)
            RECT r;
            if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r); // DWMWA_EXTENDED_FRAME_BOUNDS
            int pid; GetWindowThreadProcessId(h, out pid);
            string pname = "";
            try { pname = Process.GetProcessById(pid).ProcessName; } catch { }
            list.Add(new Dictionary<string, object> {
                { "handle", h.ToInt64() }, { "title", sb.ToString() }, { "process", pname }, { "pid", pid },
                { "x", r.L }, { "y", r.T }, { "w", r.R - r.L }, { "h", r.B - r.T },
                { "minimized", IsIconic(h) }, { "foreground", h == fg } });
            return true;
        }, IntPtr.Zero);
        return list;
    }
    static bool Focus(IntPtr h)
    {
        if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
        // Windows only lets the process that had the last input bring a window forward; a tap of
        // ALT counts as that input. Without it SetForegroundWindow just flashes the taskbar button.
        Send(KeyIn(0xA4, 0, 0), KeyIn(0xA4, 0, KEYEVENTF_KEYUP));
        SetForegroundWindow(h);
        Thread.Sleep(80);
        return GetForegroundWindow() == h;
    }
    static IntPtr WindowAt(int x, int y) { var p = new POINT { X = x, Y = y }; return GetAncestor(WindowFromPoint(p), 2); } // GA_ROOT
    static int OwnerPid(IntPtr h) { if (h == IntPtr.Zero) return 0; int pid; GetWindowThreadProcessId(h, out pid); return pid; }
}
