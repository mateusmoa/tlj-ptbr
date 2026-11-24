// Instalador universal das traduções de The Longest Journey (2000) — núcleo do formato .tljpatch
// Aplica os textos sobre os arquivos ORIGINAIS do jogo do próprio jogador; os pacotes não trazem
// arquivos da Funcom além do que cada tradução substitui.
//
// Compilar (Windows, com o compilador que já vem no .NET Framework 4.5+): Compilar.bat
// Compilar (mono) SEMPRE contra as referências do .NET Framework 4.5, senão o .exe usa
// métodos que só existem no mono/.NET Core e quebra no Windows:
//   mcs -langversion:5 -nostdlib -noconfig -r:/usr/lib/mono/4.5-api/mscorlib.dll -r:/usr/lib/mono/4.5-api/System.dll \
//       -r:/usr/lib/mono/4.5-api/System.Core.dll -r:/usr/lib/mono/4.5-api/System.IO.Compression.dll \
//       -r:/usr/lib/mono/4.5-api/System.IO.Compression.FileSystem.dll -target:exe -out:Instalador_TLJ.exe *.cs
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

[assembly: AssemblyTitle("Instalador universal das traducoes - The Longest Journey")]
[assembly: AssemblyProduct("TLJ - instalador universal")]
[assembly: AssemblyVersion("2.0.0.0")]
[assembly: AssemblyFileVersion("2.0.0.0")]

namespace TljPtbr
{
    /// <summary>Mensagens em português ou inglês (idioma do Windows ou --idioma).</summary>
    static class Txt
    {
        public static bool Pt = true;
        public static void Init(string forced)
        {
            string lang = forced;
            if (string.IsNullOrEmpty(lang))
            {
                try { lang = System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName; }
                catch (Exception) { lang = "en"; }
            }
            Pt = lang.ToLowerInvariant().StartsWith("pt");
        }
        public static string T(string pt, string en) { return Pt ? pt : en; }
    }

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
        public const byte OpSpeech = 1, OpImgText = 2, OpRename = 3, OpData = 4, OpMember = 6;
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
            if (o < 0 || o > b.Length - 2) throw new PatchException(Txt.T("dados truncados", "truncated data"));
            return (ushort)(b[o] | (b[o + 1] << 8));
        }

        static uint U32(byte[] b, int o)
        {
            if (o < 0 || o > b.Length - 4) throw new PatchException(Txt.T("dados truncados", "truncated data"));
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
                if (n < 0 || o < 0 || n > d.Length - o) throw new PatchException(Txt.T("arquivo de patch truncado", "truncated patch file"));
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
            return ReadPatch(File.ReadAllBytes(path));
        }

        public static Patch ReadPatch(byte[] data)
        {
            if (data.Length >= 2 && data[0] == 0x1f && data[1] == 0x8b)
            {
                try
                {
                    using (MemoryStream compressed = new MemoryStream(data, false))
                    using (GZipStream gz = new GZipStream(compressed, CompressionMode.Decompress))
                    using (MemoryStream ms = new MemoryStream())
                    {
                        gz.CopyTo(ms);
                        data = ms.ToArray();
                    }
                }
                catch (InvalidDataException) { throw new PatchException(Txt.T("o arquivo de patch está corrompido", "the patch file is corrupted")); }
            }
            Rd r = new Rd(data);
            if (!Same(r.Take(8), Magic)) throw new PatchException(Txt.T("formato de patch desconhecido; esta atualização pode exigir uma versão mais nova do instalador", "unknown patch format; this update may need a newer installer"));
            Patch p = new Patch();
            p.Version = r.S16();
            p.Title = r.S16();
            HashSet<string> paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            uint n = r.U32();
            for (uint i = 0; i < n; i++)
            {
                Entry e = new Entry();
                e.Kind = r.U8();
                e.Path = ValidateRelativePath(r.S16());
                if (!paths.Add(e.Path)) throw new PatchException(Txt.T("caminho repetido no patch: ", "repeated path in the patch: ") + e.Path);
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
                        if (ed.Op != OpSpeech && ed.Op != OpImgText && ed.Op != OpRename
                            && ed.Op != OpData && ed.Op != OpMember)
                            throw new PatchException(Txt.T("operação de patch não suportada; atualize o instalador", "unsupported patch operation; update the installer"));
                        ed.Aux = r.U32(); ed.CrcOrig = r.U32(); ed.CrcKeep = r.U32();
                        ed.Payload = r.B32();
                        e.Edits.Add(ed);
                    }
                }
                else if (e.Kind == KindFile)
                {
                    e.ShaEn = r.Take(20); e.ShaOut = r.Take(20); e.Content = r.B32();
                }
                else throw new PatchException(Txt.T("tipo de entrada desconhecido no patch", "unknown entry type in the patch"));
                p.Entries.Add(e);
            }
            return p;
        }

        public static string ValidateRelativePath(string path)
        {
            if (string.IsNullOrEmpty(path) || Path.IsPathRooted(path))
                throw new PatchException(Txt.T("caminho de arquivo inválido no patch", "invalid file path in the patch"));
            path = path.Replace('\\', '/');
            foreach (char c in path)
                if (c < 32 || ":<>\"|?*".IndexOf(c) >= 0)
                    throw new PatchException(Txt.T("caminho de arquivo inválido no patch: ", "invalid file path in the patch: ") + path);
            foreach (string part in path.Split('/'))
            {
                if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(" ") || part.EndsWith("."))
                    throw new PatchException(Txt.T("caminho de arquivo inválido no patch: ", "invalid file path in the patch: ") + path);
                string stem = part.Split('.')[0].ToUpperInvariant();
                if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL"
                    || (stem.Length == 4 && (stem.StartsWith("COM") || stem.StartsWith("LPT"))
                        && stem[3] >= '1' && stem[3] <= '9'))
                    throw new PatchException(Txt.T("nome de arquivo reservado no patch: ", "reserved file name in the patch: ") + path);
            }
            return path;
        }

        static byte[] LowerAscii(byte[] source)
        {
            byte[] result = (byte[])source.Clone();
            for (int i = 0; i < result.Length; i++)
                if (result[i] >= (byte)'A' && result[i] <= (byte)'Z') result[i] += 32;
            return result;
        }

        class AddedMember
        {
            public byte[] Name, Content;
            public uint Flag;
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
                if (o + 6 > end) throw new PatchException(Txt.T("árvore .xrc truncada", "truncated .xrc tree"));
                Node nd = new Node();
                nd.Type = x[o]; nd.Sub = x[o + 1];
                nd.NameOff = o + 4;
                nd.NameLen = U16(x, nd.NameOff);
                nd.DataOff = nd.NameOff + 2 + nd.NameLen;
                if (nd.DataOff + 4 > end) throw new PatchException(Txt.T("árvore .xrc truncada", "truncated .xrc tree"));
                long dl = U32(x, nd.DataOff);
                if (nd.DataOff + 4 + dl > end) throw new PatchException(Txt.T("árvore .xrc truncada", "truncated .xrc tree"));
                nd.DataLen = (int)dl;
                o = nd.DataOff + 4 + nd.DataLen;
                if (o + 4 > end) throw new PatchException(Txt.T("árvore .xrc truncada", "truncated .xrc tree"));
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
            if (buf.Length < 12) throw new PatchException(Txt.T("arquivo .xarc muito pequeno", ".xarc file too small"));
            uint version = U32(buf, 0), num = U32(buf, 4), first = U32(buf, 8);
            if (num > 100000) throw new PatchException(Txt.T("tabela do .xarc inconsistente", "inconsistent .xarc table"));
            List<byte[]> names = new List<byte[]>();
            List<uint> flags = new List<uint>(), lens = new List<uint>();
            int o = 12;
            for (uint i = 0; i < num; i++)
            {
                if (o < 0 || o >= buf.Length) throw new PatchException(Txt.T("tabela do .xarc inconsistente", "inconsistent .xarc table"));
                int z = Array.IndexOf<byte>(buf, 0, o);
                if (z < 0) throw new PatchException(Txt.T("tabela do .xarc inconsistente", "inconsistent .xarc table"));
                names.Add(Slice(buf, o, z - o));
                o = z + 1;
                lens.Add(U32(buf, o)); flags.Add(U32(buf, o + 4));
                o += 8;
            }
            if (first < o) throw new PatchException(Txt.T("tabela do .xarc inconsistente", "inconsistent .xarc table"));
            long off = first;
            List<int> offs = new List<int>();
            for (int i = 0; i < names.Count; i++)
            {
                if (off + lens[i] > buf.Length) throw new PatchException(Txt.T("tabela do .xarc inconsistente", "inconsistent .xarc table"));
                offs.Add((int)off);
                off += lens[i];
            }
            if (off != buf.Length) throw new PatchException(Txt.T("tamanho do .xarc inconsistente", "inconsistent .xarc size"));
            int xi = -1;
            for (int i = 0; i < names.Count; i++)
            {
                string nm = Encoding.GetEncoding(28591).GetString(names[i]).ToLowerInvariant();
                if (nm.EndsWith(".xrc")) { xi = i; break; }
            }
            if (xi < 0) throw new PatchException(Txt.T("o .xarc não contém .xrc", "the .xarc has no .xrc"));
            int xo = offs[xi], xl = (int)lens[xi];
            List<Node> nodes = ParseNodes(buf, xo, xl);
            if (nodes.Count != e.NodeCount)
                throw new PatchException(string.Format(Txt.T("estrutura diferente da esperada ({0} nós, esperado {1})", "unexpected structure ({0} nodes, expected {1})"), nodes.Count, e.NodeCount));
            List<Rep> reps = new List<Rep>();
            Dictionary<int, byte[]> swaps = new Dictionary<int, byte[]>();
            List<AddedMember> added = new List<AddedMember>();
            foreach (Edit ed in e.Edits)
            {
                if (ed.Op == OpMember)
                {
                    if (ed.Payload.Length < 2) throw new PatchException(Txt.T("arquivo interno inválido no patch", "invalid internal file in the patch"));
                    int nameLength = U16(ed.Payload, 0);
                    if (nameLength == 0 || nameLength > ed.Payload.Length - 2)
                        throw new PatchException(Txt.T("arquivo interno inválido no patch", "invalid internal file in the patch"));
                    byte[] name = Slice(ed.Payload, 2, nameLength);
                    byte[] lowerName = LowerAscii(name);
                    if (Array.IndexOf<byte>(name, 0) >= 0 || Crc32(lowerName) != ed.CrcKeep)
                        throw new PatchException(Txt.T("arquivo interno inválido no patch", "invalid internal file in the patch"));
                    byte[] content = Slice(ed.Payload, 2 + nameLength, ed.Payload.Length - 2 - nameLength);
                    int memberIndex = -1;
                    for (int i = 0; i < names.Count; i++)
                        if (Same(LowerAscii(names[i]), lowerName)) { memberIndex = i; break; }
                    if (memberIndex == xi) throw new PatchException(Txt.T("arquivo interno do .xarc diferente do esperado", "unexpected internal .xarc file"));
                    if (memberIndex >= 0) swaps[memberIndex] = content;
                    else added.Add(new AddedMember { Name = name, Flag = ed.Aux, Content = content });
                    continue;
                }
                if (ed.Node >= nodes.Count) throw new PatchException(Txt.T("nó inexistente", "missing node"));
                Node nd = nodes[(int)ed.Node];
                if (nd.Type != ed.Type || nd.Sub != ed.Sub) throw new PatchException(Txt.T("tipo de nó diferente do esperado", "unexpected node type"));
                if (ed.Op == OpRename)
                {
                    reps.Add(new Rep { A = nd.NameOff, B = nd.NameOff + 2 + nd.NameLen, Bytes = Concat(Le16(ed.Payload.Length), ed.Payload) });
                    continue;
                }
                int d0 = nd.DataOff + 4, dl = nd.DataLen;
                byte[] nw;
                if (ed.Op == OpSpeech)
                {
                    if (dl < 2) throw new PatchException(Txt.T("fala inválida", "invalid speech"));
                    int tl = U16(buf, d0);
                    if (2 + tl > dl) throw new PatchException(Txt.T("fala inválida", "invalid speech"));
                    if (Crc32(buf, d0 + 2 + tl, dl - 2 - tl) != ed.CrcKeep) throw new PatchException(Txt.T("dados da fala diferentes do esperado", "unexpected speech data"));
                    nw = Concat(Le16(ed.Payload.Length), ed.Payload, Slice(buf, d0 + 2 + tl, dl - 2 - tl));
                }
                else if (ed.Op == OpImgText)
                {
                    int x = (int)ed.Aux;
                    if (x + 2 > dl) throw new PatchException(Txt.T("texto de imagem inválido", "invalid image text"));
                    int tl = U16(buf, d0 + x);
                    if (x + 2 + tl > dl) throw new PatchException(Txt.T("texto de imagem inválido", "invalid image text"));
                    byte[] head = Slice(buf, d0, x), trail = Slice(buf, d0 + x + 2 + tl, dl - x - 2 - tl);
                    if (Crc32(Concat(head, trail)) != ed.CrcKeep) throw new PatchException(Txt.T("dados do texto de imagem diferentes do esperado", "unexpected image text data"));
                    nw = Concat(head, Le16(ed.Payload.Length), ed.Payload, trail);
                }
                else if (ed.Op == OpData)
                {
                    nw = ed.Payload;
                }
                else throw new PatchException(Txt.T("operação desconhecida no patch", "unknown patch operation"));
                byte[] lenb = new byte[] { (byte)nw.Length, (byte)(nw.Length >> 8), (byte)(nw.Length >> 16), (byte)(nw.Length >> 24) };
                reps.Add(new Rep { A = nd.DataOff, B = d0 + dl, Bytes = Concat(lenb, nw) });
            }
            reps.Sort((p, q) => p.A.CompareTo(q.A));
            MemoryStream nx = new MemoryStream(xl + 65536);
            int pos = xo;
            foreach (Rep r in reps)
            {
                if (r.A < pos) throw new PatchException(Txt.T("edições sobrepostas", "overlapping edits"));
                Put(nx, buf, pos, r.A - pos);
                Put(nx, r.Bytes, 0, r.Bytes.Length);
                pos = r.B;
            }
            Put(nx, buf, pos, xo + xl - pos);
            byte[] newXrc = nx.ToArray();
            swaps[xi] = newXrc;
            MemoryStream outp = new MemoryStream(buf.Length + 65536);
            MemoryStream table = new MemoryStream();
            for (int i = 0; i < names.Count; i++)
            {
                Put(table, names[i], 0, names[i].Length);
                table.WriteByte(0);
                W32(table, swaps.ContainsKey(i) ? (long)swaps[i].Length : (long)lens[i]);
                W32(table, flags[i]);
            }
            foreach (AddedMember member in added)
            {
                Put(table, member.Name, 0, member.Name.Length); table.WriteByte(0);
                W32(table, member.Content.Length); W32(table, member.Flag);
            }
            W32(outp, version); W32(outp, names.Count + added.Count); W32(outp, 12 + table.Length);
            table.WriteTo(outp);
            for (int i = 0; i < names.Count; i++)
            {
                if (swaps.ContainsKey(i)) Put(outp, swaps[i], 0, swaps[i].Length);
                else Put(outp, buf, offs[i], (int)lens[i]);
            }
            foreach (AddedMember member in added) Put(outp, member.Content, 0, member.Content.Length);
            byte[] res = outp.ToArray();
            bool ok = Same(Sha1(res), e.ShaOut) && res.Length == e.SizeOut;
            if (isOrig)
            {
                if (!ok) throw new PatchException(Txt.T("resultado inesperado (patch e jogo não combinam)", "unexpected result (patch and game do not match)"));
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
            if (buf == null) throw new PatchException(Txt.T("arquivo não encontrado", "file not found"));
            return ApplyXarc(buf, e, out status);
        }
    }

}
