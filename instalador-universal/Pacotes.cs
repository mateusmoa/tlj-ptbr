// Pacotes que o instalador universal reconhece: texto (.tljpatch) e arquivos soltos do jogo
// (vídeos .bbb, falas .ovs da Steam, falas .iss da GOG/4CD), em ZIP ou em pasta extraída.
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text.RegularExpressions;

namespace TljPtbr
{
    enum Kind { Texto, Video, AudioSteam, AudioGog, Arquivos }

    class PFile
    {
        public string Rel;        // caminho relativo à pasta do jogo (com "/")
        public string Source;     // nome da entrada no ZIP, ou caminho completo na pasta
        public long Size;
    }

    class Package
    {
        public string Name;       // nome do ZIP, da pasta ou do .tljpatch
        public string Origin;     // caminho do ZIP/pasta/.tljpatch
        public bool IsZip;
        public Kind Kind;
        public List<PFile> Files = new List<PFile>();
        public long TotalSize;
        public byte[] PatchBytes; // pacote de texto
        public Patch Patch;
        public string Problem;    // motivo de incompatibilidade (null = compatível)

        public string Version
        {
            get { return Patch != null ? Patch.Version : ""; }
        }

        public string Label
        {
            get
            {
                if (Kind == Kind.Texto && Patch != null) return Patch.Title + " (" + Txt.T("versão ", "version ") + Patch.Version + ")";
                return Name;
            }
        }

        /// <summary>percorre os arquivos do pacote abrindo cada um uma vez, na ordem</summary>
        public void ForEach(Action<PFile, Stream> action)
        {
            if (IsZip)
            {
                using (ZipArchive z = ZipFile.OpenRead(Origin))
                {
                    Dictionary<string, ZipArchiveEntry> map = new Dictionary<string, ZipArchiveEntry>(StringComparer.Ordinal);
                    foreach (ZipArchiveEntry en in z.Entries) map[en.FullName] = en;
                    foreach (PFile f in Files)
                        using (Stream s = map[f.Source].Open()) action(f, s);
                }
            }
            else
            {
                foreach (PFile f in Files)
                    using (Stream s = File.OpenRead(f.Source)) action(f, s);
            }
        }
    }

    static class Packages
    {
        // níveis do jogo: 08..7c (dois dígitos hexadecimais até 7f), global, static e fonts;
        // nomes de idioma ("de", "fr"...) não contam como pasta do jogo
        static readonly Regex RootDir = new Regex(@"^([0-7][0-9a-f]|global|static|fonts)$", RegexOptions.IgnoreCase);
        static readonly Regex RootFile = new Regex(@"^(chapters\.ini|language\.ini|gui\.ini|w_world\.ini|x\.xarc)$", RegexOptions.IgnoreCase);
        static readonly Regex Asset = new Regex(@"\.(xarc|bbb|sss|ssn|iss|ovs|isn|ttf|otf|ttc|fon)$", RegexOptions.IgnoreCase);

        public static string KindName(Kind k)
        {
            switch (k)
            {
                case Kind.Texto: return Txt.T("Texto", "Text");
                case Kind.Video: return Txt.T("Vídeos", "Videos");
                case Kind.AudioSteam: return Txt.T("Áudio Steam", "Steam audio");
                case Kind.AudioGog: return Txt.T("Áudio GOG", "GOG audio");
                default: return Txt.T("Arquivos", "Files");
            }
        }

        public static string KindId(Kind k)
        {
            switch (k)
            {
                case Kind.Texto: return "texto";
                case Kind.Video: return "video";
                case Kind.AudioSteam: return "audio_steam";
                case Kind.AudioGog: return "audio_gog";
                default: return "arquivos";
            }
        }

        public static Kind KindFromId(string id)
        {
            switch ((id ?? "").ToLowerInvariant())
            {
                case "video": return Kind.Video;
                case "audio_steam": return Kind.AudioSteam;
                case "audio_gog": return Kind.AudioGog;
                case "arquivos": return Kind.Arquivos;
                default: return Kind.Texto;
            }
        }

        /// <summary>índice do primeiro segmento que pertence à raiz do jogo, ou -1 (mesma regra da extensão do Vortex)</summary>
        public static int RootIndex(string[] parts)
        {
            foreach (string p in parts) if (p.Equals("mods", StringComparison.OrdinalIgnoreCase)) return -1;
            for (int i = 0; i < parts.Length; i++)
            {
                if (i == parts.Length - 1) return RootFile.IsMatch(parts[i]) ? i : -1;
                if (RootDir.IsMatch(parts[i]) && Asset.IsMatch(parts[parts.Length - 1])) return i;
            }
            return -1;
        }

        static string[] Split(string p)
        {
            List<string> r = new List<string>();
            foreach (string s in p.Replace('\\', '/').Split('/')) if (s.Length > 0) r.Add(s);
            return r.ToArray();
        }

        /// <summary>monta um pacote de arquivos soltos a partir de (nome, tamanho); o prefixo mais votado vira a raiz</summary>
        static Package Loose(string name, string origin, bool isZip, List<KeyValuePair<string, long>> files)
        {
            Dictionary<string, int> votes = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            foreach (KeyValuePair<string, long> f in files)
            {
                string[] parts = Split(f.Key);
                int idx = RootIndex(parts);
                if (idx < 0) continue;
                string pre = string.Join("/", parts, 0, idx);
                votes[pre] = (votes.ContainsKey(pre) ? votes[pre] : 0) + 1;
            }
            if (votes.Count == 0) return null;
            string prefix = null; int best = -1;
            foreach (KeyValuePair<string, int> v in votes) if (v.Value > best) { best = v.Value; prefix = v.Key; }
            string[] pre2 = Split(prefix);
            Package pk = new Package();
            pk.Name = name; pk.Origin = origin; pk.IsZip = isZip;
            int ovs = 0, iss = 0, bbb = 0, other = 0;
            foreach (KeyValuePair<string, long> f in files)
            {
                string[] parts = Split(f.Key);
                if (parts.Length <= pre2.Length) continue;
                bool same = true;
                for (int i = 0; i < pre2.Length; i++) if (!parts[i].Equals(pre2[i], StringComparison.OrdinalIgnoreCase)) { same = false; break; }
                if (!same) continue;
                string[] relParts = new string[parts.Length - pre2.Length];
                Array.Copy(parts, pre2.Length, relParts, 0, relParts.Length);
                if (RootIndex(relParts) != 0) continue;       // leia-me, imagens etc. não vão para o jogo
                string rel = string.Join("/", relParts);
                if (rel.EndsWith(".vortex_backup", StringComparison.OrdinalIgnoreCase)) continue;
                PFile pf = new PFile(); pf.Rel = Core.ValidateRelativePath(rel); pf.Source = f.Key; pf.Size = f.Value;
                pk.Files.Add(pf); pk.TotalSize += f.Value;
                string ext = Path.GetExtension(rel).ToLowerInvariant();
                if (ext == ".ovs") ovs++; else if (ext == ".iss") iss++; else if (ext == ".bbb" || ext == ".sss") bbb++; else other++;
            }
            if (pk.Files.Count == 0) return null;
            if (ovs > 0 && iss == 0 && ovs >= bbb) pk.Kind = Kind.AudioSteam;
            else if (iss > 0 && ovs == 0 && iss >= bbb) pk.Kind = Kind.AudioGog;
            else if (bbb > 0 && ovs == 0 && iss == 0) pk.Kind = Kind.Video;
            else pk.Kind = Kind.Arquivos;
            return pk;
        }

        static Package TextPackage(string name, string origin, bool isZip, byte[] data)
        {
            Package pk = new Package();
            pk.Name = name; pk.Origin = origin; pk.IsZip = isZip; pk.Kind = Kind.Texto;
            pk.PatchBytes = data; pk.TotalSize = data.Length;
            pk.Patch = Core.ReadPatch(data);
            return pk;
        }

        /// <summary>lê um ZIP: cada .tljpatch vira um pacote de texto; o resto, se for arquivo do jogo, um pacote solto</summary>
        public static List<Package> FromZip(string zipPath, List<string> warnings)
        {
            List<Package> result = new List<Package>();
            try
            {
                using (ZipArchive z = ZipFile.OpenRead(zipPath))
                {
                    List<KeyValuePair<string, long>> files = new List<KeyValuePair<string, long>>();
                    foreach (ZipArchiveEntry en in z.Entries)
                    {
                        if (en.FullName.EndsWith("/") || en.FullName.EndsWith("\\")) continue;
                        if (en.FullName.EndsWith(".tljpatch", StringComparison.OrdinalIgnoreCase))
                        {
                            byte[] data;
                            using (Stream s = en.Open())
                            using (MemoryStream ms = new MemoryStream())
                            {
                                s.CopyTo(ms); data = ms.ToArray();
                            }
                            try { result.Add(TextPackage(Path.GetFileName(zipPath), zipPath, true, data)); }
                            catch (PatchException ex) { warnings.Add(Path.GetFileName(zipPath) + ": " + ex.Message); }
                            continue;
                        }
                        files.Add(new KeyValuePair<string, long>(en.FullName, en.Length));
                    }
                    if (result.Count == 0)
                    {
                        Package pk = Loose(Path.GetFileName(zipPath), zipPath, true, files);
                        if (pk != null) result.Add(pk);
                    }
                }
            }
            catch (InvalidDataException) { warnings.Add(Path.GetFileName(zipPath) + ": " + Txt.T("ZIP corrompido ou incompleto", "corrupted or incomplete ZIP")); }
            catch (IOException ex) { warnings.Add(Path.GetFileName(zipPath) + ": " + ex.Message); }
            catch (UnauthorizedAccessException ex) { warnings.Add(Path.GetFileName(zipPath) + ": " + ex.Message); }
            return result;
        }

        /// <summary>pasta extraída: cada .tljpatch vira um pacote de texto; os arquivos do jogo são agrupados
        /// pela pasta onde começa a estrutura do jogo (ex.: dados/Videos/global/xarc -> pacote "Videos")</summary>
        public static List<Package> FromFolder(string folder, List<string> warnings)
        {
            List<Package> result = new List<Package>();
            List<KeyValuePair<string, long>> files = new List<KeyValuePair<string, long>>();
            string root = Path.GetFullPath(folder).TrimEnd('\\', '/');
            Walk(root, root, 0, files, result, warnings);
            Dictionary<string, List<KeyValuePair<string, long>>> groups = new Dictionary<string, List<KeyValuePair<string, long>>>(StringComparer.OrdinalIgnoreCase);
            foreach (KeyValuePair<string, long> f in files)
            {
                string[] parts = Split(f.Key);
                int idx = RootIndex(parts);
                if (idx < 0) continue;
                string pre = string.Join("/", parts, 0, idx);
                string rel = string.Join("/", parts, idx, parts.Length - idx);
                if (!groups.ContainsKey(pre)) groups[pre] = new List<KeyValuePair<string, long>>();
                groups[pre].Add(new KeyValuePair<string, long>(rel, f.Value));
            }
            List<string> keys = new List<string>(groups.Keys);
            keys.Sort(StringComparer.OrdinalIgnoreCase);
            foreach (string pre in keys)
            {
                string groot = pre.Length == 0 ? root : Path.Combine(root, pre.Replace('/', Path.DirectorySeparatorChar));
                string name = pre.Length == 0 ? Path.GetFileName(root) : pre;
                Package pk = Loose(name, groot, false, groups[pre]);
                if (pk == null) continue;
                foreach (PFile f in pk.Files) f.Source = Path.Combine(groot, f.Source.Replace('/', Path.DirectorySeparatorChar));
                result.Add(pk);
            }
            return result;
        }

        static void Walk(string root, string dir, int depth, List<KeyValuePair<string, long>> files, List<Package> result, List<string> warnings)
        {
            if (depth > 8) return;
            string[] fs, ds;
            try { fs = Directory.GetFiles(dir); ds = Directory.GetDirectories(dir); }
            catch (UnauthorizedAccessException) { return; }
            catch (IOException) { return; }
            Array.Sort(fs, StringComparer.OrdinalIgnoreCase);
            Array.Sort(ds, StringComparer.OrdinalIgnoreCase);
            foreach (string f in fs)
            {
                if (f.EndsWith(".tljpatch", StringComparison.OrdinalIgnoreCase))
                {
                    try { result.Add(TextPackage(Path.GetFileName(f), f, false, File.ReadAllBytes(f))); }
                    catch (PatchException ex) { warnings.Add(Path.GetFileName(f) + ": " + ex.Message); }
                    continue;
                }
                if (f.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)) continue;
                string rel = f.Substring(root.Length).TrimStart('\\', '/').Replace('\\', '/');
                files.Add(new KeyValuePair<string, long>(rel, new FileInfo(f).Length));
            }
            foreach (string d in ds)
                if ((File.GetAttributes(d) & FileAttributes.ReparsePoint) == 0)
                    Walk(root, d, depth + 1, files, result, warnings);
        }

        /// <summary>procura pacotes na pasta de dados: ZIPs (em qualquer nível) e conteúdo extraído;
        /// os ZIPs lidos entram em "visited" para não serem lidos duas vezes</summary>
        public static List<Package> Scan(string dataFolder, List<string> warnings, HashSet<string> visited)
        {
            List<Package> result = new List<Package>();
            if (!Directory.Exists(dataFolder)) return result;
            List<string> zips = new List<string>();
            FindZips(dataFolder, 0, zips);
            zips.Sort(StringComparer.OrdinalIgnoreCase);
            foreach (string z in zips) if (visited.Add(z)) result.AddRange(FromZip(z, warnings));
            result.AddRange(FromFolder(dataFolder, warnings));
            return result;
        }

        static void FindZips(string dir, int depth, List<string> zips)
        {
            if (depth > 4) return;
            try
            {
                foreach (string f in Directory.GetFiles(dir, "*.zip")) zips.Add(Path.GetFullPath(f));
                foreach (string d in Directory.GetDirectories(dir))
                    if ((File.GetAttributes(d) & FileAttributes.ReparsePoint) == 0) FindZips(d, depth + 1, zips);
            }
            catch (UnauthorizedAccessException) { }
            catch (IOException) { }
        }

        /// <summary>pacote indicado direto pelo jogador: ZIP, .tljpatch ou pasta</summary>
        public static List<Package> FromPath(string path, List<string> warnings)
        {
            if (File.Exists(path))
            {
                if (path.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)) return FromZip(Path.GetFullPath(path), warnings);
                if (path.EndsWith(".tljpatch", StringComparison.OrdinalIgnoreCase))
                {
                    List<Package> r = new List<Package>();
                    try { r.Add(TextPackage(Path.GetFileName(path), Path.GetFullPath(path), false, File.ReadAllBytes(path))); }
                    catch (PatchException ex) { warnings.Add(Path.GetFileName(path) + ": " + ex.Message); }
                    return r;
                }
            }
            if (Directory.Exists(path)) return Scan(path, warnings, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            warnings.Add(Txt.T("não encontrado: ", "not found: ") + path);
            return new List<Package>();
        }
    }
}
