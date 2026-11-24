// Instalador universal das traduções de The Longest Journey (Steam/GOG em inglês).
// Instala, atualiza e remove pacotes de texto (.tljpatch), vídeos (.bbb) e áudio Steam (.ovs) ou GOG (.iss),
// sem o Vortex. Guarda os originais em _backup_traducao_tlj e sabe voltar ao estado anterior.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace TljPtbr
{
    class Manifest
    {
        // arquivo relativo -> tipo do pacote que o instalou
        public Dictionary<string, Kind> Files = new Dictionary<string, Kind>(StringComparer.OrdinalIgnoreCase);
        // tipo -> "nome\tversão" do pacote instalado
        public Dictionary<Kind, string> Packages = new Dictionary<Kind, string>();
    }

    class Program
    {
        const string Version = "2.0.0";
        const string BackupDir = "_backup_traducao_tlj";
        const string LegacyBackupDir = "_backup_traducao_ptbr";   // instalador PT-BR 1.x
        const string ManifestName = "instalado.txt";
        const string SteamApp = "6310";
        const string GogApp = "1207658794";
        static string dataFolder;
        static bool interactive = true;
        static string[] origArgs = new string[0];

        static void Say(string s) { Console.WriteLine(s); }
        static void Say() { Console.WriteLine(); }
        static string T(string pt, string en) { return Txt.T(pt, en); }

        static string Mb(long b) { return (b / 1048576.0).ToString(b < 10485760 ? "0.0" : "0") + " MB"; }

        // ------------------------------------------------------------ pasta do jogo
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
                        if (Directory.Exists(cur))
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

        /// <summary>todas as instalações encontradas (pasta do instalador, Steam e GOG), sem repetir</summary>
        static List<string> FindGames()
        {
            List<string> found = new List<string>();
            Action<string> add = delegate(string c)
            {
                if (!IsGameDir(c)) return;
                string full = Path.GetFullPath(c).TrimEnd('\\', '/');
                if (!found.Exists(x => string.Equals(x, full, StringComparison.OrdinalIgnoreCase))) found.Add(full);
            };
            string exeDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(new char[] { '\\', '/' });
            foreach (string c in new string[] { Environment.CurrentDirectory, exeDir, Path.GetDirectoryName(exeDir) }) add(c);
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
                add(Path.Combine(Path.Combine(apps, "common"), inst));
            }
            foreach (RegistryView v in new RegistryView[] { RegistryView.Registry32, RegistryView.Registry64 })
                add(RegValue(RegistryHive.LocalMachine, v, @"SOFTWARE\GOG.com\Games\" + GogApp, "path"));
            foreach (string c in new string[] { @"C:\GOG Games\The Longest Journey", @"C:\Program Files (x86)\GOG Galaxy\Games\The Longest Journey",
                                                 @"C:\Program Files (x86)\GOG.com\The Longest Journey", @"C:\Program Files (x86)\Funcom\The Longest Journey" })
                add(c);
            return found;
        }

        /// <summary>formato das falas soltas da instalação: "ovs" (Steam/DVD), "iss" (GOG/4CD) ou "" (não deu para saber)</summary>
        static string AudioFormat(string game)
        {
            int ovs = 0, iss = 0, dirs = 0;
            try
            {
                foreach (string level in Directory.GetDirectories(game))
                {
                    if (!Regex.IsMatch(Path.GetFileName(level), "^[0-9a-f]{2}$", RegexOptions.IgnoreCase)) continue;
                    foreach (string loc in Directory.GetDirectories(level))
                    {
                        string x = ResolveCi(loc, "xarc");
                        if (!Directory.Exists(x)) continue;
                        foreach (string f in Directory.GetFiles(x))
                        {
                            string e = Path.GetExtension(f).ToLowerInvariant();
                            if (e == ".ovs") ovs++; else if (e == ".iss") iss++;
                        }
                        if (++dirs >= 12 && (ovs + iss) > 50) break;
                    }
                    if (dirs >= 12 && (ovs + iss) > 50) break;
                }
            }
            catch (Exception) { }
            if (ovs > iss * 4) return "ovs";
            if (iss > ovs * 4) return "iss";
            return "";
        }

        static string StoreLabel(string game, string audio)
        {
            string g = game.ToLowerInvariant();
            string store = g.Contains("steamapps") ? "Steam" : (g.Contains("gog") ? "GOG" : T("loja desconhecida", "unknown store"));
            string a = audio == "ovs" ? T("falas .ovs", ".ovs speech") : audio == "iss" ? T("falas .iss", ".iss speech") : T("formato das falas não identificado", "speech format not identified");
            return store + ", " + a;
        }

        // ------------------------------------------------------------ backup e manifesto
        // os caminhos do backup são resolvidos sem diferenciar maiúsculas/minúsculas, como no Windows:
        // patches de idiomas diferentes escrevem "global/Global.xarc" e "global/global.xarc"
        static string BackupPath(string game, string rel)
        {
            return ResolveCi(BackupRoot(game), rel);
        }

        /// <summary>marcador de "o jogo não tinha este arquivo"</summary>
        static string MarkerPath(string game, string rel)
        {
            return ResolveCi(BackupRoot(game), rel + ".nao_existia");
        }

        /// <summary>pasta de backup em uso; antes da migração (ex.: em --verificar), a do instalador PT-BR 1.x</summary>
        static string BackupRoot(string game)
        {
            string cur = Path.Combine(game, BackupDir), legacy = Path.Combine(game, LegacyBackupDir);
            return !Directory.Exists(cur) && Directory.Exists(legacy) ? legacy : cur;
        }

        /// <summary>caminho relativo com as maiúsculas/minúsculas reais das pastas e arquivos que já existem no jogo</summary>
        static string Canon(string game, string rel)
        {
            string root = Path.GetFullPath(game).TrimEnd('\\', '/');
            string full = Path.GetFullPath(ResolveCi(game, rel));
            if (full.Length > root.Length + 1 && full.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                return full.Substring(root.Length + 1).Replace('\\', '/');
            return rel;
        }

        static bool HasBackup(string game, string rel)
        {
            return File.Exists(BackupPath(game, rel)) || File.Exists(MarkerPath(game, rel));
        }

        /// <summary>backup do original na primeira vez que o arquivo é tocado (cópia atômica: um backup
        /// pela metade nunca pode virar "original")</summary>
        static void EnsureBackup(string game, string rel, string target)
        {
            if (HasBackup(game, rel)) return;
            string bp = BackupPath(game, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(bp));
            if (File.Exists(target))
            {
                string tmp = bp + ".tmp_tlj";
                File.Copy(target, tmp, true);
                File.SetAttributes(tmp, FileAttributes.Normal);
                Replace(tmp, bp);
            }
            else File.WriteAllBytes(MarkerPath(game, rel), new byte[0]);
        }

        /// <summary>volta um arquivo ao original (ou o apaga, se o jogo não o tinha) e descarta o backup dele</summary>
        static void RestoreFile(string game, string rel)
        {
            string bp = BackupPath(game, rel);
            string marker = MarkerPath(game, rel);
            string dst = ResolveCi(game, rel);
            if (File.Exists(marker))
            {
                if (File.Exists(dst))
                {
                    File.SetAttributes(dst, FileAttributes.Normal);
                    File.Delete(dst);
                    PruneEmpty(Path.GetDirectoryName(dst), game);   // ex.: pasta criada só para um arquivo novo
                }
                File.Delete(marker);
            }
            else if (File.Exists(bp))
            {
                WriteAtomic(dst, File.ReadAllBytes(bp));
                File.SetAttributes(bp, FileAttributes.Normal);
                File.Delete(bp);
            }
        }

        /// <summary>apaga pastas vazias de "dir" para cima, sem passar de "stop"</summary>
        static void PruneEmpty(string dir, string stop)
        {
            try
            {
                string s = Path.GetFullPath(stop).TrimEnd('\\', '/');
                string d = Path.GetFullPath(dir).TrimEnd('\\', '/');
                while (d.Length > s.Length && d.StartsWith(s, StringComparison.OrdinalIgnoreCase)
                       && Directory.Exists(d) && Directory.GetFileSystemEntries(d).Length == 0)
                {
                    Directory.Delete(d);
                    d = Path.GetDirectoryName(d);
                }
            }
            catch (Exception) { }
        }

        static void WriteAtomic(string path, byte[] data)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path)));
            string tmp = path + ".tmp_tlj";
            File.WriteAllBytes(tmp, data);
            Replace(tmp, path);
        }

        static void Replace(string tmp, string path)
        {
            if (File.Exists(path))
            {
                File.SetAttributes(path, FileAttributes.Normal);   // arquivos de CD às vezes vêm "somente leitura"
                File.Delete(path);
            }
            File.Move(tmp, path);
        }

        /// <summary>a pasta de backup do instalador PT-BR 1.x passa a ser a do instalador universal</summary>
        static void MigrateLegacy(string game)
        {
            string legacy = Path.Combine(game, LegacyBackupDir), cur = Path.Combine(game, BackupDir);
            if (Directory.Exists(legacy) && !Directory.Exists(cur))
            {
                Directory.Move(legacy, cur);
                Say(T("Backup do instalador PT-BR anterior reaproveitado (" + LegacyBackupDir + " -> " + BackupDir + ").",
                      "Backup from the previous PT-BR installer reused (" + LegacyBackupDir + " -> " + BackupDir + ")."));
            }
        }

        static Manifest LoadManifest(string game)
        {
            Manifest m = new Manifest();
            string dir = Path.Combine(game, BackupDir);
            if (!Directory.Exists(dir) && Directory.Exists(Path.Combine(game, LegacyBackupDir))) dir = Path.Combine(game, LegacyBackupDir);
            string f = Path.Combine(dir, ManifestName);
            if (!File.Exists(f)) return m;
            bool v2 = false;
            string legacyVersion = "";
            foreach (string line in File.ReadAllLines(f, Encoding.UTF8))
            {
                string[] c = line.Split('\t');
                if (c.Length >= 2 && c[0] == "formato") { v2 = true; continue; }
                if (v2)
                {
                    if (c.Length >= 3 && c[0] == "arquivo") m.Files[c[2]] = Packages.KindFromId(c[1]);
                    else if (c.Length >= 4 && c[0] == "pacote") m.Packages[Packages.KindFromId(c[1])] = c[2] + "\t" + c[3];
                }
                else if (c.Length >= 2 && c[0] == "versao") legacyVersion = c[1];
                else if (c.Length >= 2 && c[0] == "modo") continue;                       // patcher PT-BR em Python (--scummvm)
                else if (c.Length >= 2 && c[0].Length > 0) m.Files[c[0]] = Kind.Texto;   // manifesto 1.x: só texto
            }
            if (!v2 && m.Files.Count > 0) m.Packages[Kind.Texto] = "TLJ PT-BR\t" + legacyVersion;
            return m;
        }

        static void SaveManifest(string game, Manifest m)
        {
            string dir = Path.Combine(game, BackupDir);
            if (m.Files.Count == 0)
            {
                // nada instalado: se o backup ficou vazio, some com ele
                if (Directory.Exists(dir))
                {
                    string mf = Path.Combine(dir, ManifestName);
                    if (File.Exists(mf)) File.Delete(mf);
                    bool empty = Directory.GetFiles(dir, "*", SearchOption.AllDirectories).Length == 0;
                    if (empty) Directory.Delete(dir, true);
                    else WriteManifest(dir, m);
                }
                return;
            }
            Directory.CreateDirectory(dir);
            WriteManifest(dir, m);
        }

        static void WriteManifest(string dir, Manifest m)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("formato\t2\n");
            sb.Append("instalador\t" + Version + "\n");
            foreach (KeyValuePair<Kind, string> p in m.Packages) sb.Append("pacote\t" + Packages.KindId(p.Key) + "\t" + p.Value + "\n");
            List<string> keys = new List<string>(m.Files.Keys);
            keys.Sort(StringComparer.OrdinalIgnoreCase);
            foreach (string k in keys) sb.Append("arquivo\t" + Packages.KindId(m.Files[k]) + "\t" + k + "\n");
            File.WriteAllText(Path.Combine(dir, ManifestName), sb.ToString(), new UTF8Encoding(false));
        }

        // ------------------------------------------------------------ conferência
        static bool AudioKind(Kind k) { return k == Kind.AudioSteam || k == Kind.AudioGog; }

        static void CheckCompat(Package p, string audio)
        {
            p.Problem = null;
            if (p.Kind == Kind.AudioSteam && audio == "iss")
                p.Problem = T("áudio para a Steam (.ovs), mas este jogo usa falas .iss (GOG)", "Steam audio (.ovs), but this game uses .iss speech (GOG)");
            else if (p.Kind == Kind.AudioGog && audio == "ovs")
                p.Problem = T("áudio para a GOG (.iss), mas este jogo usa falas .ovs (Steam)", "GOG audio (.iss), but this game uses .ovs speech (Steam)");
        }

        static List<string> VortexManaged(string game, IEnumerable<string> rels)
        {
            List<string> hits = new List<string>();
            foreach (string r in rels)
                if (File.Exists(ResolveCi(game, r) + ".vortex_backup")) { hits.Add(r); if (hits.Count > 3) break; }
            return hits;
        }

        static IEnumerable<string> RelsOf(Package p)
        {
            if (p.Kind == Kind.Texto) foreach (Entry e in p.Patch.Entries) yield return e.Path;
            else foreach (PFile f in p.Files) yield return f.Rel;
        }

        /// <summary>original de um arquivo (do backup, se já foi trocado) ou o arquivo atual</summary>
        static byte[] OriginalOrCurrent(string game, string rel, out bool fromBackup)
        {
            string bp = BackupPath(game, rel);
            fromBackup = true;
            if (File.Exists(bp)) return File.ReadAllBytes(bp);
            if (File.Exists(MarkerPath(game, rel))) return null;
            fromBackup = false;
            string path = ResolveCi(game, rel);
            return File.Exists(path) ? File.ReadAllBytes(path) : null;
        }

        /// <summary>confere se o patch de texto combina com o jogo; devolve os problemas</summary>
        static List<string> CheckText(string game, Package p, Dictionary<string, int> counts)
        {
            List<string> problems = new List<string>();
            int i = 0;
            foreach (Entry e in p.Patch.Entries)
            {
                i++;
                bool fromBackup;
                string st = "";
                try
                {
                    byte[] buf = OriginalOrCurrent(game, Canon(game, e.Path), out fromBackup);
                    if (buf == null && e.Kind == Core.KindXarc) problems.Add(T("faltando: ", "missing: ") + e.Path);
                    else Core.ApplyEntry(buf, e, out st);
                }
                catch (PatchException ex) { problems.Add(T("diferente: ", "different: ") + e.Path + ": " + ex.Message); }
                if (st != "") counts[st] = (counts.ContainsKey(st) ? counts[st] : 0) + 1;
                if (i % 25 == 0) Console.Write("\r  " + i + "/" + p.Patch.Entries.Count);
            }
            Console.Write("\r                \r");
            return problems;
        }

        // ------------------------------------------------------------ instalar
        static void ReplaceKind(string game, Manifest m, Kind kind, HashSet<string> keep)
        {
            List<string> old = new List<string>();
            foreach (KeyValuePair<string, Kind> kv in m.Files) if (kv.Value == kind && !keep.Contains(kv.Key)) old.Add(kv.Key);
            foreach (string rel in old) { RestoreFile(game, rel); m.Files.Remove(rel); }
            if (old.Count > 0)
                Say(T("  " + old.Count + " arquivo(s) do pacote anterior deste tipo voltaram ao original.",
                      "  " + old.Count + " file(s) from the previous package of this type were restored."));
        }

        static string StatusName(string st)
        {
            switch (st)
            {
                case "original": return T("a partir do original", "from the original");
                case "divergente": return T("de outra edição (adaptados)", "from another edition (adapted)");
                case "atualizado": return T("substituídos", "replaced");
                case "ja_instalado": return T("já estavam assim", "already up to date");
                default: return st;
            }
        }

        // ------------------------------------------------------------ texto x ScummVM
        // mesmas regras da extensão do Vortex: o ScummVM 2026.4 lê os textos em cp1252, exceto nas versões
        // que ele reconhece pelo chapters.ini (polonês cp1250, russo cp1251, hebraico cp1255)
        static readonly Dictionary<string, string> ScummvmCodepage = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { "6abc5c38e6e31face4b675355b117620", "cp1250" },
            { "740b97b94e97ed11f064f5fa125ebee1", "cp1251" },
            { "8e08025c89575d2573c2edf0daa1cb34", "cp1251" },
            { "17510546145f6f574702094dca436a8d", "cp1251" },
            { "53c9b6087044be0ba05f8d7b39c8ae48", "cp1255" },
        };

        /// <summary>conjunto de caracteres dos textos do patch, pela frequência dos bytes</summary>
        static string TextEncodingOf(Patch patch)
        {
            double[] cnt = new double[256];
            foreach (Entry e in patch.Entries)
                foreach (Edit ed in e.Edits)
                    if (ed.Op == Core.OpSpeech || ed.Op == Core.OpImgText || ed.Op == Core.OpRename)
                        foreach (byte b in ed.Payload) cnt[b]++;
            double letters = 0, high = 0, upper = 0;
            for (int b = 65; b <= 90; b++) letters += cnt[b] + cnt[b + 32];
            for (int b = 128; b < 256; b++) high += cnt[b];
            for (int b = 192; b < 256; b++) upper += cnt[b];
            double total = letters + high;
            if (total < 200) return "cp1252";
            if (high / total > 0.5) return upper / high > 0.9 ? "cp1251" : "cjk";
            double undef = cnt[0x81] + cnt[0x8D] + cnt[0x8F] + cnt[0x90] + cnt[0x9D];
            if ((cnt[0xB3] + cnt[0xB9]) / total > 0.002 || (cnt[0xEC] / total > 0.002 && cnt[0xF8] / total > 0.002) || undef / total > 0.0005) return "cp1250";
            return "cp1252";
        }

        static string Md5Hex(byte[] b)
        {
            using (System.Security.Cryptography.MD5 md5 = System.Security.Cryptography.MD5.Create())
            {
                StringBuilder sb = new StringBuilder();
                foreach (byte x in md5.ComputeHash(b)) sb.Append(x.ToString("x2"));
                return sb.ToString();
            }
        }

        /// <summary>avisa quando o texto instalado só aparece certo no jogo original</summary>
        static void ScummvmNotice(string game, Patch patch)
        {
            string enc = TextEncodingOf(patch);
            if (enc == "cp1252") return;
            byte[] chapters = null;
            foreach (Entry e in patch.Entries)
                if (e.Kind == Core.KindFile && e.Path.Equals("chapters.ini", StringComparison.OrdinalIgnoreCase)) chapters = e.Content;
            if (chapters == null)
            {
                string cp = ResolveCi(game, "chapters.ini");
                if (File.Exists(cp)) chapters = File.ReadAllBytes(cp);
            }
            string codepage = "cp1252";
            if (chapters != null && ScummvmCodepage.ContainsKey(Md5Hex(chapters))) codepage = ScummvmCodepage[Md5Hex(chapters)];
            if (enc == codepage) return;
            string label = enc == "cp1250" ? T("Windows-1250 (Europa Central)", "Windows-1250 (Central European)")
                         : enc == "cp1251" ? T("Windows-1251 (cirílico)", "Windows-1251 (Cyrillic)")
                         : T("CJK (chinês, japonês ou coreano)", "CJK (Chinese, Japanese or Korean)");
            Say(T("  Aviso: esta tradução usa o conjunto de caracteres " + label + ".",
                  "  Note: this translation uses the " + label + " character set."));
            Say(T("  No jogo original (game.exe) os textos aparecem certos; no ScummVM ficam ilegíveis,",
                  "  Texts display correctly in the original game (game.exe); in ScummVM they come out garbled,"));
            Say(T("  porque o ScummVM ainda não lê esse conjunto nesta versão do jogo. Jogue pelo game.exe.",
                  "  because ScummVM cannot read that character set for this game version yet. Play with game.exe."));
        }

        static int InstallText(string game, Package p, Manifest m, bool dry)
        {
            Say(T("Texto: ", "Text: ") + p.Label);
            Say(T("  Conferindo " + p.Patch.Entries.Count + " arquivos...", "  Checking " + p.Patch.Entries.Count + " files..."));
            Dictionary<string, int> counts = new Dictionary<string, int>();
            List<string> problems = CheckText(game, p, counts);
            if (problems.Count > 0)
            {
                Say(T("  Não dá para instalar: alguns arquivos do jogo não são os esperados.", "  Cannot install: some game files are not the expected ones."));
                for (int k = 0; k < Math.Min(15, problems.Count); k++) Say("    " + problems[k]);
                Say(T("  Solução: na Steam, Propriedades > Arquivos instalados > Verificar integridade",
                      "  Fix: in Steam, Properties > Installed Files > Verify integrity"));
                Say(T("  (na GOG Galaxy: Gerenciar instalação > Verificar/Reparar) e rode o instalador de novo.",
                      "  (in GOG Galaxy: Manage installation > Verify/Repair) and run the installer again."));
                return 1;
            }
            string resumo = "";
            foreach (string st in new string[] { "original", "divergente", "atualizado", "ja_instalado" })
                if (counts.ContainsKey(st)) resumo += (resumo == "" ? "" : ", ") + counts[st] + " " + StatusName(st);
            if (dry) { Say(T("  Tudo certo para instalar (" + resumo + ").", "  Ready to install (" + resumo + ").")); return 0; }
            HashSet<string> keep = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (Entry e in p.Patch.Entries) keep.Add(Canon(game, e.Path));
            ReplaceKind(game, m, Kind.Texto, keep);
            DropOverlapping(game, m, Kind.Arquivos, keep);
            int i = 0;
            foreach (Entry e in p.Patch.Entries)
            {
                i++;
                string rel = Canon(game, e.Path);
                string path = ResolveCi(game, rel);
                bool fromBackup;
                byte[] src = OriginalOrCurrent(game, rel, out fromBackup);   // sempre a partir do original
                string st;
                byte[] outb = Core.ApplyEntry(src, e, out st);
                EnsureBackup(game, rel, path);
                byte[] cur = File.Exists(path) ? File.ReadAllBytes(path) : null;
                if (cur == null || !Core.Same(cur, outb)) WriteAtomic(path, outb);
                m.Files[rel] = Kind.Texto;
                if (i % 25 == 0) Console.Write("\r  " + i + "/" + p.Patch.Entries.Count);
            }
            Console.Write("\r                \r");
            m.Packages[Kind.Texto] = p.Patch.Title + "\t" + p.Patch.Version;
            Say(T("  Texto instalado (" + resumo + ").", "  Text installed (" + resumo + ")."));
            ScummvmNotice(game, p.Patch);
            return 0;
        }

        /// <summary>se um pacote instalado do tipo "kind" mexe nos mesmos arquivos do novo pacote,
        /// ele sai inteiro (ex.: texto .tljpatch x arquivos prontos do mesmo idioma)</summary>
        static void DropOverlapping(string game, Manifest m, Kind kind, HashSet<string> rels)
        {
            bool overlap = false;
            foreach (KeyValuePair<string, Kind> kv in m.Files) if (kv.Value == kind && rels.Contains(kv.Key)) { overlap = true; break; }
            if (!overlap) return;
            string old = m.Packages.ContainsKey(kind) ? m.Packages[kind].Split('\t')[0] : Packages.KindName(kind);
            Say(T("  O pacote anterior \"" + old + "\" mexia nos mesmos arquivos e foi removido.",
                  "  The previous package \"" + old + "\" changed the same files and was removed."));
            ReplaceKind(game, m, kind, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            m.Packages.Remove(kind);
        }

        static int InstallFiles(string game, Package p, Manifest m, bool dry)
        {
            Say(Packages.KindName(p.Kind) + ": " + p.Name + " — " + p.Files.Count + T(" arquivos, ", " files, ") + Mb(p.TotalSize));
            if (p.Problem != null) { Say(T("  Ignorado: ", "  Skipped: ") + p.Problem); return 0; }
            if (dry) { Say(T("  Tudo certo para instalar.", "  Ready to install.")); return 0; }
            HashSet<string> keep = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (PFile f in p.Files) keep.Add(Canon(game, f.Rel));
            ReplaceKind(game, m, p.Kind, keep);
            if (p.Kind == Kind.Arquivos) DropOverlapping(game, m, Kind.Texto, keep);
            // o outro áudio (Steam x GOG) não pode ficar misturado
            if (p.Kind == Kind.AudioSteam) ReplaceKind(game, m, Kind.AudioGog, new HashSet<string>());
            if (p.Kind == Kind.AudioGog) ReplaceKind(game, m, Kind.AudioSteam, new HashSet<string>());
            int i = 0; long done = 0, changed = 0;
            byte[] buffer = new byte[1 << 16];
            p.ForEach(delegate(PFile f, Stream s)
            {
                i++;
                string rel = Canon(game, f.Rel);
                string path = ResolveCi(game, rel);
                EnsureBackup(game, rel, path);
                string tmp = path + ".tmp_tlj";
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path)));
                using (FileStream o = File.Create(tmp))
                {
                    int n;
                    while ((n = s.Read(buffer, 0, buffer.Length)) > 0) o.Write(buffer, 0, n);
                }
                if (File.Exists(path) && FilesEqual(tmp, path)) File.Delete(tmp);
                else { Replace(tmp, path); changed++; }
                m.Files[rel] = p.Kind;
                done += f.Size;
                if (i % 50 == 0 || i == p.Files.Count) Console.Write("\r  " + i + "/" + p.Files.Count + " (" + Mb(done) + ")   ");
            });
            Console.Write("\r                                        \r");
            m.Packages[p.Kind] = p.Name + "\t" + "";
            Say(T("  " + p.Files.Count + " arquivos instalados (" + changed + " alterados).", "  " + p.Files.Count + " files installed (" + changed + " changed)."));
            return 0;
        }

        static bool FilesEqual(string a, string b)
        {
            FileInfo fa = new FileInfo(a), fb = new FileInfo(b);
            if (fa.Length != fb.Length) return false;
            using (FileStream sa = File.OpenRead(a))
            using (FileStream sb = File.OpenRead(b))
            {
                byte[] x = new byte[1 << 16], y = new byte[1 << 16];
                while (true)
                {
                    int n = sa.Read(x, 0, x.Length);
                    if (n == 0) return true;
                    int got = 0;
                    while (got < n) { int k = sb.Read(y, got, n - got); if (k == 0) return false; got += k; }
                    for (int j = 0; j < n; j++) if (x[j] != y[j]) return false;
                }
            }
        }

        static int Install(string game, List<Package> chosen, bool dry)
        {
            List<string> rels = new List<string>();
            foreach (Package p in chosen) rels.AddRange(RelsOf(p));
            List<string> vortex = VortexManaged(game, rels);
            if (vortex.Count > 0)
            {
                Say(T("ATENÇÃO: há arquivos .vortex_backup nesta pasta (ex.: " + vortex[0] + "): o Vortex está",
                      "WARNING: there are .vortex_backup files in this folder (e.g. " + vortex[0] + "): Vortex manages"));
                Say(T("gerenciando mods deste jogo. Use o Vortex, ou desative os mods e faça Purge antes.",
                      "mods for this game. Use Vortex, or disable the mods and Purge first."));
                return 2;
            }
            if (!dry)
            {
                try
                {
                    MigrateLegacy(game);
                    string probe = Path.Combine(game, "_teste_escrita_tlj.tmp");
                    File.WriteAllBytes(probe, new byte[] { 1 });
                    File.Delete(probe);
                }
                catch (UnauthorizedAccessException) { return NeedAdmin(); }
            }
            // texto e "arquivos prontos" que trocam os mesmos arquivos são alternativas: fica o texto
            Package text = chosen.Find(x => x.Kind == Kind.Texto);
            if (text != null)
            {
                HashSet<string> trels = new HashSet<string>(RelsOf(text), StringComparer.OrdinalIgnoreCase);
                chosen = chosen.FindAll(delegate(Package x)
                {
                    if (x.Kind != Kind.Arquivos) return true;
                    foreach (PFile f in x.Files)
                        if (trels.Contains(f.Rel))
                        {
                            Say(T("Ignorado: " + x.Name + " troca os mesmos arquivos do texto escolhido (instale um ou outro).",
                                  "Skipped: " + x.Name + " replaces the same files as the chosen text (install one or the other)."));
                            return false;
                        }
                    return true;
                });
            }
            Manifest m = LoadManifest(game);
            int rc = 0;
            try
            {
                // texto primeiro: se ele não combinar com o jogo, nada mais é instalado
                foreach (Package p in chosen) if (p.Kind == Kind.Texto) { rc = InstallText(game, p, m, dry); if (rc != 0) return rc; }
                foreach (Package p in chosen) if (p.Kind != Kind.Texto) { int r = InstallFiles(game, p, m, dry); if (r != 0) rc = r; }
            }
            catch (UnauthorizedAccessException) { if (!dry) SaveManifest(game, m); return NeedAdmin(); }
            finally { if (!dry) SaveManifest(game, m); }
            if (!dry)
            {
                Say();
                Say(T("Pronto! Backup dos originais em: ", "Done! Originals backed up in: ") + Path.Combine(game, BackupDir));
                Say(T("Para desfazer, rode o instalador de novo e escolha \"Desinstalar\".", "To undo, run the installer again and choose \"Uninstall\"."));
            }
            return rc;
        }

        // ------------------------------------------------------------ desinstalar
        static int Uninstall(string game, string what)
        {
            try { MigrateLegacy(game); }
            catch (UnauthorizedAccessException) { return NeedAdmin(); }
            string bdir = Path.Combine(game, BackupDir);
            if (!Directory.Exists(bdir))
            {
                Say(T("Não encontrei a pasta de backup (" + BackupDir + "). Nada a desinstalar.", "Backup folder (" + BackupDir + ") not found. Nothing to uninstall."));
                Say(T("Para voltar ao inglês de qualquer jeito: Steam > Verificar integridade dos arquivos.", "To get back to English anyway: Steam > Verify integrity of game files."));
                return 1;
            }
            Manifest m = LoadManifest(game);
            int restored = 0;
            try
            {
                if (what == "tudo")
                {
                    foreach (string src in Directory.GetFiles(bdir, "*", SearchOption.AllDirectories))
                    {
                        string rel = src.Substring(bdir.Length).TrimStart(new char[] { '\\', '/' }).Replace('\\', '/');
                        if (rel == ManifestName) continue;
                        if (rel.EndsWith(".tmp_tlj")) { File.Delete(src); continue; }   // resto de uma cópia interrompida
                        if (rel.EndsWith(".nao_existia")) rel = rel.Substring(0, rel.Length - ".nao_existia".Length);
                        RestoreFile(game, rel);
                        restored++;
                    }
                    m.Files.Clear(); m.Packages.Clear();
                }
                else
                {
                    List<Kind> kinds = new List<Kind>();
                    if (what == "texto") kinds.Add(Kind.Texto);
                    if (what == "video") kinds.Add(Kind.Video);
                    if (what == "audio") { kinds.Add(Kind.AudioSteam); kinds.Add(Kind.AudioGog); }
                    if (what == "arquivos") kinds.Add(Kind.Arquivos);
                    List<string> rels = new List<string>();
                    foreach (KeyValuePair<string, Kind> kv in m.Files) if (kinds.Contains(kv.Value)) rels.Add(kv.Key);
                    foreach (string rel in rels) { RestoreFile(game, rel); m.Files.Remove(rel); restored++; }
                    foreach (Kind k in kinds) m.Packages.Remove(k);
                }
                SaveManifest(game, m);
                if (what == "tudo" && Directory.Exists(bdir))
                {
                    foreach (string f in Directory.GetFiles(bdir, "*", SearchOption.AllDirectories)) File.SetAttributes(f, FileAttributes.Normal);
                    Directory.Delete(bdir, true);
                }
            }
            catch (UnauthorizedAccessException) { return NeedAdmin(); }
            Say(T("Pronto! " + restored + " arquivo(s) voltaram ao estado anterior.", "Done! " + restored + " file(s) restored."));
            return 0;
        }

        // ------------------------------------------------------------ administrador
        static int NeedAdmin()
        {
            Say();
            Say(T("Sem permissão para escrever na pasta do jogo.", "No permission to write to the game folder."));
            if (!interactive) { Say(T("Rode o instalador como administrador.", "Run the installer as administrator.")); return 3; }
            Console.Write(T("Reabrir o instalador como administrador? (S/N) ", "Restart the installer as administrator? (Y/N) "));
            string a = (Console.ReadLine() ?? "").Trim().ToUpperInvariant();
            if (a.StartsWith("S") || a.StartsWith("Y"))
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
                catch (Exception) { Say(T("Não foi possível pedir permissão de administrador.", "Could not request administrator rights.")); }
            }
            return 3;
        }

        // ------------------------------------------------------------ menus
        static string Ask(string prompt)
        {
            Console.Write(prompt);
            string a = Console.ReadLine();
            return a == null ? "" : a.Trim();
        }

        /// <summary>só cabe um pacote por "vaga": texto, vídeos, áudio (Steam ou GOG) e arquivos</summary>
        static bool SameSlot(Kind a, Kind b) { return a == b || (AudioKind(a) && AudioKind(b)); }

        static Kind FirstDuplicate(List<Package> ok)
        {
            foreach (Kind k in new Kind[] { Kind.Texto, Kind.Video, Kind.AudioSteam, Kind.Arquivos })
                if (ok.FindAll(p => SameSlot(p.Kind, k)).Count > 1) return k;
            return (Kind)(-1);
        }

        static List<Package> Choose(List<Package> all, bool askUser)
        {
            List<Package> ok = new List<Package>();
            foreach (Package p in all) if (p.Problem == null) ok.Add(p);
            if (!askUser)
            {
                Kind d = FirstDuplicate(ok);
                if (d != (Kind)(-1))
                {
                    string kn = AudioKind(d) ? T("áudio", "audio") : Packages.KindName(d).ToLowerInvariant();
                    Say(T("Há mais de um pacote de " + kn + ". Indique qual com --pacote.", "More than one " + kn + " package found. Pick one with --pacote."));
                    return null;
                }
                return ok;
            }
            Say();
            Say(T("  1) Instalar/atualizar todos os pacotes compatíveis", "  1) Install/update all compatible packages"));
            Say(T("  2) Escolher quais pacotes instalar", "  2) Choose which packages to install"));
            Say(T("  3) Desinstalar", "  3) Uninstall"));
            Say(T("  4) Sair", "  4) Exit"));
            string c = Ask(T("Escolha e aperte Enter: ", "Choose and press Enter: "));
            if (c == "3") return new List<Package>(new Package[] { null });   // marcador: desinstalar
            if (c == "1")
            {
                if (FirstDuplicate(ok) == (Kind)(-1)) return ok;
                Say(T("Há mais de um pacote do mesmo tipo; escolha os números.", "Several packages of the same type; pick the numbers."));
            }
            else if (c != "2") return new List<Package>();
            string sel = Ask(T("Números separados por vírgula (ex.: 1,3): ", "Numbers separated by commas (e.g. 1,3): "));
            List<Package> chosen = new List<Package>();
            foreach (string part in sel.Split(',', ' ', ';'))
            {
                int n;
                if (!int.TryParse(part.Trim(), out n) || n < 1 || n > all.Count) continue;
                Package p = all[n - 1];
                if (p.Problem != null) { Say(T("Ignorado (incompatível): ", "Skipped (incompatible): ") + p.Name); continue; }
                if (chosen.Exists(x => SameSlot(x.Kind, p.Kind))) { Say(T("Só um pacote por tipo; ignorado: ", "Only one package per type; skipped: ") + p.Name); continue; }
                chosen.Add(p);
            }
            return chosen;
        }

        /// <summary>menu de desinstalação com só o que está instalado</summary>
        static string AskUninstall(string game)
        {
            Manifest m = LoadManifest(game);
            List<string> ids = new List<string>(new string[] { "tudo" });
            List<string> labels = new List<string>(new string[] { T("Tudo (voltar aos arquivos originais)", "Everything (back to the original files)") });
            bool audio = false;
            foreach (Kind k in m.Files.Values) if (AudioKind(k)) audio = true;
            if (m.Files.ContainsValue(Kind.Texto)) { ids.Add("texto"); labels.Add(T("Só o texto", "Text only")); }
            if (m.Files.ContainsValue(Kind.Video)) { ids.Add("video"); labels.Add(T("Só os vídeos", "Videos only")); }
            if (audio) { ids.Add("audio"); labels.Add(T("Só o áudio", "Audio only")); }
            if (m.Files.ContainsValue(Kind.Arquivos)) { ids.Add("arquivos"); labels.Add(T("Só os arquivos prontos", "Ready-made files only")); }
            if (ids.Count == 2) { ids.RemoveAt(1); labels.RemoveAt(1); }   // um tipo só: "tudo" já resolve
            for (int i = 0; i < ids.Count; i++) Say("  " + (i + 1) + ") " + labels[i]);
            Say("  " + (ids.Count + 1) + ") " + T("Cancelar", "Cancel"));
            int n;
            if (int.TryParse(Ask(T("Escolha e aperte Enter: ", "Choose and press Enter: ")), out n) && n >= 1 && n <= ids.Count) return ids[n - 1];
            return null;
        }

        static void ShowPackages(List<Package> all)
        {
            if (all.Count == 0) return;
            Say(T("Pacotes encontrados:", "Packages found:"));
            for (int i = 0; i < all.Count; i++)
            {
                Package p = all[i];
                string extra = p.Kind == Kind.Texto ? "  [" + p.Name + "]" : " — " + p.Files.Count + T(" arquivos, ", " files, ") + Mb(p.TotalSize);
                Say("  " + (i + 1) + ") [" + Packages.KindName(p.Kind) + "] " + p.Label + extra);
                if (p.Problem != null) Say(T("       incompatível: ", "       incompatible: ") + p.Problem);
            }
        }

        static void ShowInstalled(string game)
        {
            Manifest m = LoadManifest(game);
            if (m.Packages.Count == 0) return;
            Say(T("Já instalado por este instalador:", "Already installed by this installer:"));
            foreach (KeyValuePair<Kind, string> p in m.Packages)
            {
                string[] c = p.Value.Split('\t');
                Say("  - " + Packages.KindName(p.Key) + ": " + c[0] + (c.Length > 1 && c[1] != "" ? " (" + c[1] + ")" : ""));
            }
        }

        // ------------------------------------------------------------ principal
        static void Help()
        {
            Say(T("Instalador universal " + Version + " — The Longest Journey (Steam/GOG em inglês).", "Universal installer " + Version + " — The Longest Journey (English Steam/GOG)."));
            Say(T("Coloque os ZIPs dos pacotes (texto, vídeos, áudio) na pasta dados, ao lado do EXE.", "Put the package ZIPs (text, videos, audio) in the dados folder next to the EXE."));
            Say(T("Opções: --jogo PASTA  --dados PASTA  --pacote ZIP_TLJPATCH_OU_PASTA (pode repetir)", "Options: --jogo FOLDER  --dados FOLDER  --pacote ZIP_TLJPATCH_OR_FOLDER (repeatable)"));
            Say(T("        --instalar | --verificar | --desinstalar [tudo|texto|video|audio|arquivos]", "        --instalar | --verificar | --desinstalar [tudo|texto|video|audio|arquivos]"));
            Say(T("        --sim (sem perguntas)  --idioma pt|en", "        --sim (no questions)  --idioma pt|en"));
        }

        /// <summary>pacotes indicados com --pacote, ou os da pasta dados e os ZIPs ao lado do EXE</summary>
        static List<Package> FindPackages(List<string> pkgs, string audio)
        {
            List<string> warnings = new List<string>();
            List<Package> all = new List<Package>();
            if (pkgs.Count > 0) foreach (string p in pkgs) all.AddRange(Packages.FromPath(p, warnings));
            else
            {
                HashSet<string> visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                all.AddRange(Packages.Scan(dataFolder, warnings, visited));
                string exeDir = AppDomain.CurrentDomain.BaseDirectory;
                foreach (string f in Directory.GetFiles(exeDir, "*.zip"))
                    if (visited.Add(Path.GetFullPath(f))) all.AddRange(Packages.FromZip(Path.GetFullPath(f), warnings));
            }
            // o mesmo .tljpatch em dois lugares (ex.: o ZIP e uma cópia extraída) aparece uma vez só
            HashSet<string> seen = new HashSet<string>();
            all = all.FindAll(p => p.Kind != Kind.Texto || seen.Add(Convert.ToBase64String(Core.Sha1(p.PatchBytes))));
            foreach (string w in warnings) Say(T("Aviso: ", "Warning: ") + w);
            foreach (Package p in all) CheckCompat(p, audio);
            if (all.Count > 0) Say();
            return all;
        }

        static int Run(string[] args)
        {
            string game = null, action = null, what = "tudo", lang = null;
            List<string> pkgs = new List<string>();
            dataFolder = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "dados");
            for (int k = 0; k < args.Length; k++)
                if (args[k].ToLowerInvariant() == "--idioma" && k + 1 < args.Length) lang = args[k + 1];
            Txt.Init(lang);
            for (int k = 0; k < args.Length; k++)
            {
                string a = args[k];
                string al = a.ToLowerInvariant().Replace('/', '-').Replace("--", "-");
                if (al == "-ajuda" || al == "-help" || al == "-?") { Help(); interactive = false; return 0; }
                else if (al == "-idioma" && k + 1 < args.Length) k++;
                else if (al == "-dados" && k + 1 < args.Length) dataFolder = Path.GetFullPath(args[++k]);
                else if ((al == "-pacote" || al == "-patch") && k + 1 < args.Length) pkgs.Add(args[++k]);
                else if (al == "-jogo" && k + 1 < args.Length) game = args[++k];
                else if (al == "-instalar") action = "i";
                else if (al == "-verificar") action = "v";
                else if (al == "-desinstalar")
                {
                    action = "u";
                    if (k + 1 < args.Length && Regex.IsMatch(args[k + 1], "^(tudo|texto|video|audio|arquivos)$", RegexOptions.IgnoreCase)) what = args[++k].ToLowerInvariant();
                }
                else if (al == "-sim") interactive = false;
                else if (Directory.Exists(a)) game = a;      // pasta arrastada para cima do .exe
                else if (File.Exists(a)) pkgs.Add(a);        // ZIP ou .tljpatch arrastado
            }
            Say("==============================================================");
            Say(T("  The Longest Journey — Instalador universal " + Version, "  The Longest Journey — Universal installer " + Version));
            Say(T("  Texto, vídeos e áudio (Steam/GOG) sem o Vortex", "  Text, videos and audio (Steam/GOG) without Vortex"));
            Say("==============================================================");
            if (game == null)
            {
                List<string> games = FindGames();
                if (games.Count == 1) game = games[0];
                else if (games.Count > 1)
                {
                    if (!interactive) game = games[0];
                    else
                    {
                        Say(T("Achei mais de uma instalação:", "Found more than one installation:"));
                        for (int i = 0; i < games.Count; i++) Say("  " + (i + 1) + ") " + games[i] + "  (" + StoreLabel(games[i], AudioFormat(games[i])) + ")");
                        int n;
                        if (int.TryParse(Ask(T("Qual usar? ", "Which one? ")), out n) && n >= 1 && n <= games.Count) game = games[n - 1];
                        else return 0;
                    }
                }
            }
            if (game == null && interactive)
            {
                Say(T("Não achei o jogo automaticamente.", "Could not find the game automatically."));
                game = Ask(T("Cole aqui o caminho da pasta do jogo (onde fica o game.exe) e aperte Enter:\n> ",
                             "Paste the game folder path (where game.exe is) and press Enter:\n> ")).Trim('"');
            }
            if (!IsGameDir(game))
            {
                Say(T("Essa pasta não parece ser a do The Longest Journey (precisa ter game.exe e x.xarc).",
                      "This folder does not look like The Longest Journey (it needs game.exe and x.xarc)."));
                return 1;
            }
            game = Path.GetFullPath(game).TrimEnd('\\', '/');
            string audio = AudioFormat(game);
            Say(T("Jogo: ", "Game: ") + game + "  (" + StoreLabel(game, audio) + ")");
            ShowInstalled(game);
            if (action == "u")
            {
                if (interactive && what == "tudo")
                {
                    string w = AskUninstall(game);
                    if (w == null) return 0;
                    what = w;
                }
                return Uninstall(game, what);
            }

            List<Package> all = FindPackages(pkgs, audio);
            while (all.Count == 0)
            {
                Say(T("Nenhum pacote encontrado. Coloque os ZIPs dos pacotes (texto, vídeos, áudio) nesta pasta:",
                      "No package found. Put the package ZIPs (text, videos, audio) in this folder:"));
                Say("  " + dataFolder);
                Say(T("Não precisa extrair: o instalador lê os ZIPs.", "No need to extract: the installer reads the ZIPs."));
                try { Directory.CreateDirectory(dataFolder); } catch (Exception) { }
                if (!interactive) return 1;
                bool installed = Directory.Exists(Path.Combine(game, BackupDir)) || Directory.Exists(Path.Combine(game, LegacyBackupDir));
                string ans = Ask(T("Enter = procurar de novo; ou cole o caminho de um ZIP, .tljpatch ou pasta" + (installed ? "; D = desinstalar" : "") + "; S = sair\n> ",
                                   "Enter = search again; or paste the path of a ZIP, .tljpatch or folder" + (installed ? "; U = uninstall" : "") + "; Q = quit\n> ")).Trim('"', ' ');
                string up = ans.ToUpperInvariant();
                if (up == "S" || up == "Q" || up == "X") return 0;
                if (installed && (up == "D" || up == "U"))
                {
                    string w = AskUninstall(game);
                    return w == null ? 0 : Uninstall(game, w);
                }
                pkgs.Clear();
                if (ans.Length > 0) pkgs.Add(ans);
                all = FindPackages(pkgs, audio);
                Say();
            }
            ShowPackages(all);
            List<Package> chosen;
            if (action == null && interactive) chosen = Choose(all, true);
            else chosen = Choose(all, false);
            if (chosen == null) return 1;
            if (chosen.Count == 1 && chosen[0] == null)
            {
                string w = AskUninstall(game);
                return w == null ? 0 : Uninstall(game, w);
            }
            if (chosen.Count == 0) { Say(T("Nada a fazer.", "Nothing to do.")); return 0; }
            Say();
            return Install(game, chosen, action == "v");
        }

        static int Main(string[] args)
        {
            origArgs = args;
            try { Console.OutputEncoding = new UTF8Encoding(false); } catch (Exception) { }
            int rc;
            try { rc = Run(args); }
            catch (PatchException ex) { Say(T("Erro: ", "Error: ") + ex.Message); rc = 1; }
            catch (IOException ex)
            {
                Say(T("Erro de arquivo: ", "File error: ") + ex.Message);
                Say(T("Feche o jogo (e a Steam/GOG, se estiver verificando arquivos) e tente de novo.", "Close the game (and Steam/GOG if it is verifying files) and try again."));
                rc = 1;
            }
            catch (Exception ex) { Say(T("Erro inesperado: ", "Unexpected error: ") + ex.ToString()); rc = 1; }
            if (interactive)
            {
                Say();
                Console.Write(T("Aperte Enter para fechar...", "Press Enter to close..."));
                try { Console.ReadLine(); } catch (Exception) { }
            }
            return rc;
        }
    }
}
