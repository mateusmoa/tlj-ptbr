// Instalador da tradução PT-BR de The Longest Journey (2000)
// Aplica a tradução sobre os arquivos ORIGINAIS do jogo do próprio jogador.
// O pacote não contém arquivos da Funcom: só os textos traduzidos (tlj_ptbr.tljpatch).
// Faz backup de tudo que altera em "_backup_traducao_ptbr" e sabe desinstalar.
//
// Compilar (Windows, usa o compilador que já vem no Windows):
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:exe /out:Instalar_Traducao_PTBR.exe Instalador.cs
// Compilar (mono) SEMPRE contra as referências do .NET Framework, senão o .exe usa
// métodos que só existem no mono/.NET Core e quebra no Windows:
//   mcs -nostdlib -noconfig -r:/usr/lib/mono/4.0-api/mscorlib.dll -r:/usr/lib/mono/4.0-api/System.dll \
//       -target:exe -out:Instalar_Traducao_PTBR.exe Instalador.cs
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;

[assembly: AssemblyTitle("Instalador da traducao PT-BR - The Longest Journey")]
[assembly: AssemblyProduct("TLJ PT-BR")]
[assembly: AssemblyVersion("1.0.1.0")]
[assembly: AssemblyFileVersion("1.0.1.0")]

namespace TljPtbr
{
    class PatchException : Exception
    {
        public PatchException(string m) : base(m) { }
    }

    class Edit
    {
        public uint Node, Aux, CrcOrig, CrcKeep;
        public byte Type, Sub, Op;
        public byte[] Payload;
    }

    class Entry
    {
        public byte Kind;
        public string Path;
        public byte[] ShaEn, ShaOut, Content;
        public uint SizeEn, SizeOut, NodeCount;
        public List<Edit> Edits = new List<Edit>();
    }

    class Patch
    {
        public string Version, Title;
        public List<Entry> Entries = new List<Entry>();
    }

    struct Node
    {
        public byte Type, Sub;
        public int NameOff, NameLen, DataOff, DataLen;
    }

    static class Core
    {
        public const byte KindXarc = 1, KindFile = 2;
        public const byte OpSpeech = 1, OpImgText = 2, OpRename = 3, OpData = 4;
        static readonly byte[] Magic = Encoding.ASCII.GetBytes("TLJPTBR\u0001");
        static uint[] crcTable;

        public static uint Crc32(byte[] b, int off, int len)
        {
            if (crcTable == null)
            {
                crcTable = new uint[256];
                for (uint i = 0; i < 256; i++)
                {
                    uint c = i;
                    for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
                    crcTable[i] = c;
                }
            }
            uint crc = 0xFFFFFFFFu;
            for (int i = off; i < off + len; i++) crc = crcTable[(crc ^ b[i]) & 0xFF] ^ (crc >> 8);
            return crc ^ 0xFFFFFFFFu;
        }

        public static uint Crc32(byte[] b) { return Crc32(b, 0, b.Length); }

        public static byte[] Sha1(byte[] b)
        {
            using (SHA1 s = SHA1.Create()) return s.ComputeHash(b);
        }

        public static bool Same(byte[] a, byte[] b)
        {
            if (a == null || b == null || a.Length != b.Length) return false;
            for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
            return true;
        }

        static bool Same(byte[] a, int off, int len, byte[] b)
        {
            if (b.Length != len) return false;
            for (int i = 0; i < len; i++) if (a[off + i] != b[i]) return false;
            return true;
        }

        static ushort U16(byte[] b, int o)
        {
            if (o < 0 || o + 2 > b.Length) throw new PatchException("dados truncados");
            return (ushort)(b[o] | (b[o + 1] << 8));
        }

        static uint U32(byte[] b, int o)
        {
            if (o < 0 || o + 4 > b.Length) throw new PatchException("dados truncados");
            return (uint)(b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24));
        }

        static void W16(Stream s, int v) { s.WriteByte((byte)v); s.WriteByte((byte)(v >> 8)); }

        static void W32(Stream s, long v)
        {
            s.WriteByte((byte)v); s.WriteByte((byte)(v >> 8));
            s.WriteByte((byte)(v >> 16)); s.WriteByte((byte)(v >> 24));
        }

        static void Put(Stream s, byte[] b, int off, int len) { s.Write(b, off, len); }

        // ------------------------------------------------------------ leitura do patch
        class Rd
        {
            byte[] d; int o;
            public Rd(byte[] data) { d = data; }
            public byte[] Take(int n)
            {
                if (n < 0 || o + n > d.Length) throw new PatchException("arquivo de patch truncado");
                byte[] r = new byte[n]; Buffer.BlockCopy(d, o, r, 0, n); o += n; return r;
            }
            public byte U8() { return Take(1)[0]; }
            public uint U16() { byte[] b = Take(2); return (uint)(b[0] | (b[1] << 8)); }
            public uint U32() { byte[] b = Take(4); return (uint)(b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)); }
            public string S16() { return Encoding.UTF8.GetString(Take((int)U16())); }
            public byte[] B32() { return Take((int)U32()); }
        }

        public static Patch ReadPatch(string path)
        {
            byte[] data;
            try
            {
                using (FileStream fs = File.OpenRead(path))
                using (GZipStream gz = new GZipStream(fs, CompressionMode.Decompress))
                using (MemoryStream ms = new MemoryStream())
                {
                    gz.CopyTo(ms);
                    data = ms.ToArray();
                }
            }
            catch (InvalidDataException) { throw new PatchException("o arquivo de patch está corrompido"); }
            Rd r = new Rd(data);
            if (!Same(r.Take(8), Magic)) throw new PatchException("formato de patch desconhecido");
            Patch p = new Patch();
            p.Version = r.S16();
            p.Title = r.S16();
            uint n = r.U32();
            for (uint i = 0; i < n; i++)
            {
                Entry e = new Entry();
                e.Kind = r.U8();
                e.Path = r.S16();
                if (e.Kind == KindXarc)
                {
                    e.ShaEn = r.Take(20); e.SizeEn = r.U32();
                    e.ShaOut = r.Take(20); e.SizeOut = r.U32();
                    e.NodeCount = r.U32();
                    uint ne = r.U32();
                    for (uint k = 0; k < ne; k++)
                    {
                        Edit ed = new Edit();
                        ed.Node = r.U32(); ed.Type = r.U8(); ed.Sub = r.U8(); ed.Op = r.U8();
                        ed.Aux = r.U32(); ed.CrcOrig = r.U32(); ed.CrcKeep = r.U32();
                        ed.Payload = r.B32();
                        e.Edits.Add(ed);
                    }
                }
                else if (e.Kind == KindFile)
                {
                    e.ShaEn = r.Take(20); e.ShaOut = r.Take(20); e.Content = r.B32();
                }
                else throw new PatchException("tipo de entrada desconhecido no patch");
                p.Entries.Add(e);
            }
            return p;
        }

        // ------------------------------------------------------------ XARC / XRC
        static List<Node> ParseNodes(byte[] x, int baseOff, int len)
        {
            List<Node> nodes = new List<Node>();
            Stack<int> st = new Stack<int>();
            st.Push(1);
            int o = baseOff, end = baseOff + len;
            while (st.Count > 0)
            {
                int left = st.Pop();
                if (left == 0) continue;
                st.Push(left - 1);
                if (o + 6 > end) throw new PatchException("árvore .xrc truncada");
                Node nd = new Node();
                nd.Type = x[o]; nd.Sub = x[o + 1];
                nd.NameOff = o + 4;
                nd.NameLen = U16(x, nd.NameOff);
                nd.DataOff = nd.NameOff + 2 + nd.NameLen;
                if (nd.DataOff + 4 > end) throw new PatchException("árvore .xrc truncada");
                long dl = U32(x, nd.DataOff);
                if (nd.DataOff + 4 + dl > end) throw new PatchException("árvore .xrc truncada");
                nd.DataLen = (int)dl;
                o = nd.DataOff + 4 + nd.DataLen;
                if (o + 4 > end) throw new PatchException("árvore .xrc truncada");
                int nch = U16(x, o);
                o += 4;
                nodes.Add(nd);
                st.Push(nch);
            }
            return nodes;
        }

        class Rep
        {
            public int A, B; public byte[] Bytes;
        }

        static byte[] Slice(byte[] b, int off, int len)
        {
            byte[] r = new byte[len]; Buffer.BlockCopy(b, off, r, 0, len); return r;
        }

        static byte[] Concat(params byte[][] parts)
        {
            int n = 0; foreach (byte[] p in parts) n += p.Length;
            byte[] r = new byte[n]; int o = 0;
            foreach (byte[] p in parts) { Buffer.BlockCopy(p, 0, r, o, p.Length); o += p.Length; }
            return r;
        }

        static byte[] Le16(int v) { return new byte[] { (byte)v, (byte)(v >> 8) }; }

        // status: original | ja_instalado | atualizado | divergente
        public static byte[] ApplyXarc(byte[] buf, Entry e, out string status)
        {
            byte[] h = Sha1(buf);
            if (Same(h, e.ShaOut) && buf.Length == e.SizeOut) { status = "ja_instalado"; return buf; }
            bool isOrig = Same(h, e.ShaEn) && buf.Length == e.SizeEn;
            if (buf.Length < 12) throw new PatchException("arquivo .xarc muito pequeno");
            uint version = U32(buf, 0), num = U32(buf, 4), first = U32(buf, 8);
            if (num > 100000) throw new PatchException("tabela do .xarc inconsistente");
            List<byte[]> names = new List<byte[]>();
            List<uint> flags = new List<uint>(), lens = new List<uint>();
            int o = 12;
            for (uint i = 0; i < num; i++)
            {
                int z = Array.IndexOf<byte>(buf, 0, o);
                if (z < 0) throw new PatchException("tabela do .xarc inconsistente");
                names.Add(Slice(buf, o, z - o));
                o = z + 1;
                lens.Add(U32(buf, o)); flags.Add(U32(buf, o + 4));
                o += 8;
            }
            long off = first;
            List<int> offs = new List<int>();
            for (int i = 0; i < names.Count; i++)
            {
                if (off + lens[i] > buf.Length) throw new PatchException("tabela do .xarc inconsistente");
                offs.Add((int)off);
                off += lens[i];
            }
            if (off != buf.Length) throw new PatchException("tamanho do .xarc inconsistente");
            int xi = -1;
            for (int i = 0; i < names.Count; i++)
            {
                string nm = Encoding.GetEncoding(28591).GetString(names[i]).ToLowerInvariant();
                if (nm.EndsWith(".xrc")) { xi = i; break; }
            }
            if (xi < 0) throw new PatchException("o .xarc não contém .xrc");
            int xo = offs[xi], xl = (int)lens[xi];
            List<Node> nodes = ParseNodes(buf, xo, xl);
            if (nodes.Count != e.NodeCount)
                throw new PatchException(string.Format("estrutura diferente da esperada ({0} nós, esperado {1})", nodes.Count, e.NodeCount));
            List<Rep> reps = new List<Rep>();
            foreach (Edit ed in e.Edits)
            {
                if (ed.Node >= nodes.Count) throw new PatchException("nó inexistente");
                Node nd = nodes[(int)ed.Node];
                if (nd.Type != ed.Type || nd.Sub != ed.Sub) throw new PatchException("tipo de nó diferente do esperado");
                if (ed.Op == OpRename)
                {
                    reps.Add(new Rep { A = nd.NameOff, B = nd.NameOff + 2 + nd.NameLen, Bytes = Concat(Le16(ed.Payload.Length), ed.Payload) });
                    continue;
                }
                int d0 = nd.DataOff + 4, dl = nd.DataLen;
                byte[] nw;
                if (ed.Op == OpSpeech)
                {
                    if (dl < 2) throw new PatchException("fala inválida");
                    int tl = U16(buf, d0);
                    if (2 + tl > dl) throw new PatchException("fala inválida");
                    if (Crc32(buf, d0 + 2 + tl, dl - 2 - tl) != ed.CrcKeep) throw new PatchException("dados da fala diferentes do esperado");
                    nw = Concat(Le16(ed.Payload.Length), ed.Payload, Slice(buf, d0 + 2 + tl, dl - 2 - tl));
                }
                else if (ed.Op == OpImgText)
                {
                    int x = (int)ed.Aux;
                    if (x + 2 > dl) throw new PatchException("texto de imagem inválido");
                    int tl = U16(buf, d0 + x);
                    if (x + 2 + tl > dl) throw new PatchException("texto de imagem inválido");
                    byte[] head = Slice(buf, d0, x), trail = Slice(buf, d0 + x + 2 + tl, dl - x - 2 - tl);
                    if (Crc32(Concat(head, trail)) != ed.CrcKeep) throw new PatchException("dados do texto de imagem diferentes do esperado");
                    nw = Concat(head, Le16(ed.Payload.Length), ed.Payload, trail);
                }
                else if (ed.Op == OpData)
                {
                    nw = ed.Payload;
                }
                else throw new PatchException("operação desconhecida no patch");
                byte[] lenb = new byte[] { (byte)nw.Length, (byte)(nw.Length >> 8), (byte)(nw.Length >> 16), (byte)(nw.Length >> 24) };
                reps.Add(new Rep { A = nd.DataOff, B = d0 + dl, Bytes = Concat(lenb, nw) });
            }
            reps.Sort((p, q) => p.A.CompareTo(q.A));
            MemoryStream nx = new MemoryStream(xl + 65536);
            int pos = xo;
            foreach (Rep r in reps)
            {
                if (r.A < pos) throw new PatchException("edições sobrepostas");
                Put(nx, buf, pos, r.A - pos);
                Put(nx, r.Bytes, 0, r.Bytes.Length);
                pos = r.B;
            }
            Put(nx, buf, pos, xo + xl - pos);
            byte[] newXrc = nx.ToArray();
            MemoryStream outp = new MemoryStream(buf.Length + 65536);
            MemoryStream table = new MemoryStream();
            for (int i = 0; i < names.Count; i++)
            {
                Put(table, names[i], 0, names[i].Length);
                table.WriteByte(0);
                W32(table, i == xi ? (long)newXrc.Length : (long)lens[i]);
                W32(table, flags[i]);
            }
            W32(outp, version); W32(outp, names.Count); W32(outp, 12 + table.Length);
            table.WriteTo(outp);
            for (int i = 0; i < names.Count; i++)
            {
                if (i == xi) Put(outp, newXrc, 0, newXrc.Length);
                else Put(outp, buf, offs[i], (int)lens[i]);
            }
            byte[] res = outp.ToArray();
            bool ok = Same(Sha1(res), e.ShaOut) && res.Length == e.SizeOut;
            if (isOrig)
            {
                if (!ok) throw new PatchException("resultado inesperado (patch e jogo não combinam)");
                status = "original";
            }
            else status = ok ? "atualizado" : "divergente";
            return res;
        }

        public static byte[] ApplyEntry(byte[] buf, Entry e, out string status)
        {
            if (e.Kind == KindFile)
            {
                if (buf != null && Same(Sha1(buf), e.ShaOut)) { status = "ja_instalado"; return buf; }
                status = (buf != null && Same(Sha1(buf), e.ShaEn)) ? "original" : "atualizado";
                return e.Content;
            }
            if (buf == null) throw new PatchException("arquivo não encontrado");
            return ApplyXarc(buf, e, out status);
        }
    }

    class Program
    {
        const string BackupDir = "_backup_traducao_ptbr";
        const string Manifest = "instalado.txt";
        const string PatchName = "tlj_ptbr.tljpatch";
        const string SteamApp = "6310";
        const string GogApp = "1207658794";
        static bool interactive = true;

        static void Say(string s) { Console.WriteLine(s); }
        static void Say() { Console.WriteLine(); }

        static string ResolveCi(string root, string rel)
        {
            string cur = root;
            foreach (string part in rel.Split(new char[] { '/' }))
            {
                string cand = Path.Combine(cur, part);
                if (!File.Exists(cand) && !Directory.Exists(cand))
                {
                    try
                    {
                        foreach (string n in Directory.GetFileSystemEntries(cur))
                            if (string.Equals(Path.GetFileName(n), part, StringComparison.OrdinalIgnoreCase)) { cand = n; break; }
                    }
                    catch (Exception) { }
                }
                cur = cand;
            }
            return cur;
        }

        static bool IsGameDir(string p)
        {
            if (string.IsNullOrEmpty(p)) return false;
            try { return File.Exists(ResolveCi(p, "game.exe")) && File.Exists(ResolveCi(p, "x.xarc")); }
            catch (Exception) { return false; }
        }

        static string RegValue(RegistryHive hive, RegistryView view, string key, string name)
        {
            try
            {
                using (RegistryKey b = RegistryKey.OpenBaseKey(hive, view))
                using (RegistryKey k = b.OpenSubKey(key))
                {
                    if (k == null) return null;
                    object v = k.GetValue(name);
                    return v == null ? null : v.ToString();
                }
            }
            catch (Exception) { return null; }
        }

        static List<string> SteamLibraries()
        {
            List<string> homes = new List<string>();
            string s1 = RegValue(RegistryHive.CurrentUser, RegistryView.Default, @"Software\Valve\Steam", "SteamPath");
            string s2 = RegValue(RegistryHive.LocalMachine, RegistryView.Registry32, @"SOFTWARE\Valve\Steam", "InstallPath");
            string s3 = RegValue(RegistryHive.LocalMachine, RegistryView.Registry64, @"SOFTWARE\Valve\Steam", "InstallPath");
            foreach (string s in new string[] { s1, s2, s3, @"C:\Program Files (x86)\Steam", @"C:\Program Files\Steam" })
                if (!string.IsNullOrEmpty(s)) homes.Add(s.Replace('/', Path.DirectorySeparatorChar));
            List<string> libs = new List<string>();
            foreach (string h in homes)
            {
                string vdf = Path.Combine(Path.Combine(h, "steamapps"), "libraryfolders.vdf");
                if (!File.Exists(vdf)) continue;
                libs.Add(h);
                try
                {
                    foreach (Match m in Regex.Matches(File.ReadAllText(vdf), "\"path\"\\s*\"([^\"]+)\""))
                        libs.Add(m.Groups[1].Value.Replace(@"\\", @"\"));
                }
                catch (Exception) { }
            }
            return libs;
        }

        static string FindGame()
        {
            string exeDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(new char[] { '\\', '/' });
            string[] near = { Environment.CurrentDirectory, exeDir, Path.GetDirectoryName(exeDir) };
            foreach (string c in near) if (IsGameDir(c)) return c;
            foreach (string lib in SteamLibraries())
            {
                string apps = Path.Combine(lib, "steamapps");
                string inst = "The Longest Journey";
                try
                {
                    string acf = Path.Combine(apps, "appmanifest_" + SteamApp + ".acf");
                    if (File.Exists(acf))
                    {
                        Match m = Regex.Match(File.ReadAllText(acf), "\"installdir\"\\s*\"([^\"]+)\"");
                        if (m.Success) inst = m.Groups[1].Value;
                    }
                }
                catch (Exception) { }
                string c = Path.Combine(Path.Combine(apps, "common"), inst);
                if (IsGameDir(c)) return c;
            }
            foreach (RegistryView v in new RegistryView[] { RegistryView.Registry32, RegistryView.Registry64 })
            {
                string g = RegValue(RegistryHive.LocalMachine, v, @"SOFTWARE\GOG.com\Games\" + GogApp, "path");
                if (IsGameDir(g)) return g;
            }
            foreach (string c in new string[] { @"C:\GOG Games\The Longest Journey", @"C:\Program Files (x86)\GOG Galaxy\Games\The Longest Journey",
                                                 @"C:\Program Files (x86)\GOG.com\The Longest Journey", @"C:\Program Files (x86)\Funcom\The Longest Journey" })
                if (IsGameDir(c)) return c;
            return null;
        }

        static string FindPatch()
        {
            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            foreach (string c in new string[] { Path.Combine(exeDir, PatchName), Path.Combine(Path.Combine(exeDir, "dados"), PatchName),
                                                 Path.Combine(Environment.CurrentDirectory, PatchName) })
                if (File.Exists(c)) return c;
            return null;
        }

        static string BackupPath(string game, string rel)
        {
            string p = Path.Combine(game, BackupDir);
            foreach (string part in rel.Split(new char[] { '/' })) p = Path.Combine(p, part);
            return p;
        }

        static void WriteAtomic(string path, byte[] data)
        {
            string tmp = path + ".tmp_ptbr";
            File.WriteAllBytes(tmp, data);
            if (File.Exists(path))
            {
                File.SetAttributes(path, FileAttributes.Normal);   // arquivos de CD às vezes vêm "somente leitura"
                File.Delete(path);
            }
            File.Move(tmp, path);
        }

        static int Install(string game, string patchPath, bool dry)
        {
            Patch p = Core.ReadPatch(patchPath);
            Say(p.Title + "  (versão " + p.Version + ")");
            Say("Pasta do jogo: " + game);
            foreach (Entry e in p.Entries)
                if (File.Exists(ResolveCi(game, e.Path) + ".vortex_backup"))
                {
                    Say();
                    Say("ATENÇÃO: há arquivos .vortex_backup nesta pasta: o Vortex está gerenciando");
                    Say("mods deste jogo. Instale/desinstale a tradução pelo Vortex para não misturar.");
                    return 2;
                }
            Say();
            Say("Conferindo " + p.Entries.Count + " arquivos...");
            List<string> problems = new List<string>();
            Dictionary<string, int> counts = new Dictionary<string, int>();
            List<string> statuses = new List<string>();
            int i = 0;
            foreach (Entry e in p.Entries)
            {
                i++;
                string path = ResolveCi(game, e.Path);
                string st = "";
                try
                {
                    byte[] buf = File.Exists(path) ? File.ReadAllBytes(path) : null;
                    if (buf == null && e.Kind == Core.KindXarc) problems.Add("faltando: " + e.Path);
                    else Core.ApplyEntry(buf, e, out st);
                }
                catch (PatchException ex) { problems.Add("diferente: " + e.Path + ": " + ex.Message); }
                statuses.Add(st);
                if (st != "") counts[st] = (counts.ContainsKey(st) ? counts[st] : 0) + 1;
                if (i % 25 == 0) Console.Write("\r  " + i + "/" + p.Entries.Count);
            }
            Console.Write("\r                \r");
            if (problems.Count > 0)
            {
                Say("Não dá para instalar: alguns arquivos do jogo não são os esperados.");
                for (int k = 0; k < Math.Min(15, problems.Count); k++) Say("  " + problems[k]);
                Say();
                Say("Solução: na Steam, clique com o botão direito no jogo > Propriedades >");
                Say("Arquivos instalados > Verificar integridade (na GOG Galaxy: Gerenciar instalação >");
                Say("Verificar/Reparar) e rode o instalador de novo.");
                return 1;
            }
            string resumo = "";
            foreach (KeyValuePair<string, int> kv in counts) resumo += (resumo == "" ? "" : ", ") + kv.Key + "=" + kv.Value;
            if (dry) { Say("Tudo certo para instalar (" + resumo + ")."); return 0; }
            if (counts.ContainsKey("ja_instalado") && counts["ja_instalado"] == p.Entries.Count)
            {
                Say("A tradução (esta versão) já está instalada. Nada a fazer.");
                return 0;
            }
            string bdir = Path.Combine(game, BackupDir);
            try
            {
                Directory.CreateDirectory(bdir);
                string probe = Path.Combine(game, "_teste_escrita_ptbr.tmp");
                File.WriteAllBytes(probe, new byte[] { 1 });
                File.Delete(probe);
            }
            catch (UnauthorizedAccessException) { return NeedAdmin(); }
            Say("Instalando...");
            StringBuilder log = new StringBuilder();
            log.Append("versao\t" + p.Version + "\n");
            int div = 0;
            i = 0;
            try
            {
                foreach (Entry e in p.Entries)
                {
                    i++;
                    if (statuses[i - 1] == "ja_instalado") { log.Append(e.Path + "\tja_instalado\n"); continue; }
                    string path = ResolveCi(game, e.Path);
                    byte[] buf = File.Exists(path) ? File.ReadAllBytes(path) : null;
                    string st;
                    byte[] outb = Core.ApplyEntry(buf, e, out st);
                    string bp = BackupPath(game, e.Path);
                    Directory.CreateDirectory(Path.GetDirectoryName(bp));
                    if (buf != null && !File.Exists(bp)) File.Copy(path, bp);
                    else if (buf == null && !File.Exists(bp + ".nao_existia")) File.WriteAllBytes(bp + ".nao_existia", new byte[0]);
                    WriteAtomic(path, outb);
                    if (st == "divergente") div++;
                    log.Append(e.Path + "\t" + st + "\n");
                    if (i % 25 == 0) Console.Write("\r  " + i + "/" + p.Entries.Count);
                }
            }
            catch (UnauthorizedAccessException) { return NeedAdmin(); }
            Console.Write("\r                \r");
            File.WriteAllText(Path.Combine(bdir, Manifest), log.ToString(), new UTF8Encoding(false));
            Say();
            Say("Pronto! Tradução instalada (" + resumo + ").");
            if (div > 0)
            {
                Say("Obs.: " + div + " arquivo(s) já estavam modificados por outra versão da tradução;");
                Say("os textos foram atualizados mesmo assim.");
            }
            Say("Backup dos arquivos anteriores em: " + bdir);
            Say("Para desinstalar, rode o instalador de novo e escolha \"Desinstalar\".");
            return 0;
        }

        static int Uninstall(string game, string patchPath)
        {
            string bdir = Path.Combine(game, BackupDir);
            if (!Directory.Exists(bdir))
            {
                Say("Não encontrei a pasta de backup (" + BackupDir + "). Nada a desinstalar.");
                Say("Para voltar ao inglês de qualquer jeito: Steam > Verificar integridade dos arquivos.");
                return 1;
            }
            Dictionary<string, byte[]> en = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
            if (patchPath != null)
            {
                try { foreach (Entry e in Core.ReadPatch(patchPath).Entries) en[e.Path] = e.ShaEn; }
                catch (Exception) { }
            }
            int restored = 0, notOrig = 0;
            try
            {
                foreach (string src in Directory.GetFiles(bdir, "*", SearchOption.AllDirectories))
                {
                    string rel = src.Substring(bdir.Length).TrimStart(new char[] { '\\', '/' }).Replace('\\', '/');
                    if (rel == Manifest) continue;
                    if (rel.EndsWith(".nao_existia"))
                    {
                        string d0 = ResolveCi(game, rel.Substring(0, rel.Length - ".nao_existia".Length));
                        if (File.Exists(d0)) File.Delete(d0);
                        restored++;
                        continue;
                    }
                    string dst = ResolveCi(game, rel);
                    byte[] data = File.ReadAllBytes(src);
                    if (en.ContainsKey(rel) && !Core.Same(Core.Sha1(data), en[rel])) notOrig++;
                    WriteAtomic(dst, data);
                    restored++;
                }
                foreach (string f in Directory.GetFiles(bdir, "*", SearchOption.AllDirectories))
                    File.SetAttributes(f, FileAttributes.Normal);   // backup de arquivo "somente leitura"
                Directory.Delete(bdir, true);
            }
            catch (UnauthorizedAccessException) { return NeedAdmin(); }
            Say("Pronto! " + restored + " arquivo(s) restaurado(s). O jogo voltou ao estado anterior.");
            if (notOrig > 0)
            {
                Say("Obs.: " + notOrig + " arquivo(s) do backup não eram os originais em inglês (havia outra");
                Say("tradução instalada antes). Para o inglês puro: Steam > Verificar integridade.");
            }
            return 0;
        }

        static string[] origArgs = new string[0];

        static int NeedAdmin()
        {
            Say();
            Say("Sem permissão para escrever na pasta do jogo.");
            if (!interactive) { Say("Rode o instalador como administrador."); return 3; }
            Console.Write("Reabrir o instalador como administrador? (S/N) ");
            string a = (Console.ReadLine() ?? "").Trim().ToUpperInvariant();
            if (a.StartsWith("S"))
            {
                try
                {
                    string argline = "";
                    foreach (string s in origArgs) argline += " \"" + s.Replace("\"", "") + "\"";
                    ProcessStartInfo psi = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, argline.Trim());
                    psi.Verb = "runas";
                    psi.UseShellExecute = true;
                    Process.Start(psi);
                    interactive = false;
                    return 0;
                }
                catch (Exception) { Say("Não foi possível pedir permissão de administrador."); }
            }
            return 3;
        }

        static int Run(string[] args)
        {
            string game = null, patch = null, action = null;
            for (int k = 0; k < args.Length; k++)
            {
                string a = args[k];
                string al = a.ToLowerInvariant();
                if (al == "--desinstalar" || al == "/desinstalar") action = "u";
                else if (al == "--instalar" || al == "/instalar") action = "i";
                else if (al == "--verificar" || al == "/verificar") action = "v";
                else if (al == "--sim" || al == "/sim") interactive = false;
                else if ((al == "--jogo" || al == "/jogo") && k + 1 < args.Length) game = args[++k];
                else if ((al == "--patch" || al == "/patch") && k + 1 < args.Length) patch = args[++k];
                else if (Directory.Exists(a)) game = a;      // pasta arrastada para cima do .exe
            }
            Say("==============================================================");
            Say("  The Longest Journey - Tradução PT-BR (instalador)");
            Say("==============================================================");
            if (patch == null) patch = FindPatch();
            if (patch == null && action != "u")
            {
                Say("Não encontrei o arquivo " + PatchName + " ao lado do instalador.");
                Say("Extraia o ZIP inteiro antes de rodar o instalador.");
                return 1;
            }
            if (game == null) game = FindGame();
            if (game == null && interactive)
            {
                Say("Não achei o jogo automaticamente.");
                Say("Cole aqui o caminho da pasta do jogo (onde fica o game.exe) e aperte Enter:");
                Console.Write("> ");
                game = (Console.ReadLine() ?? "").Trim().Trim(new char[] { '"' });
            }
            if (!IsGameDir(game))
            {
                Say("Essa pasta não parece ser a do The Longest Journey (precisa ter game.exe e x.xarc).");
                return 1;
            }
            game = Path.GetFullPath(game);
            if (action == null)
            {
                if (!interactive) action = "i";
                else
                {
                    bool installed = Directory.Exists(Path.Combine(game, BackupDir));
                    Say("Jogo encontrado em: " + game);
                    Say();
                    Say("  1) " + (installed ? "Atualizar / reinstalar a tradução" : "Instalar a tradução"));
                    Say("  2) Desinstalar (voltar aos arquivos originais)");
                    Say("  3) Sair");
                    Console.Write("Escolha 1, 2 ou 3 e aperte Enter: ");
                    string c = (Console.ReadLine() ?? "").Trim();
                    if (c == "1") action = "i";
                    else if (c == "2") action = "u";
                    else return 0;
                    Say();
                }
            }
            if (action == "u") return Uninstall(game, patch);
            return Install(game, patch, action == "v");
        }

        static int Main(string[] args)
        {
            origArgs = args;
            try { Console.OutputEncoding = new UTF8Encoding(false); } catch (Exception) { }
            int rc;
            try { rc = Run(args); }
            catch (PatchException ex) { Say("Erro: " + ex.Message); rc = 1; }
            catch (IOException ex) { Say("Erro de arquivo: " + ex.Message); Say("Feche o jogo (e a Steam/GOG, se estiver verificando arquivos) e tente de novo."); rc = 1; }
            catch (Exception ex) { Say("Erro inesperado: " + ex.ToString()); rc = 1; }
            if (interactive)
            {
                Say();
                Console.Write("Aperte Enter para fechar...");
                try { Console.ReadLine(); } catch (Exception) { }
            }
            return rc;
        }
    }
}
