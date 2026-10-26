# Formato .tljpatch (versão 1)

Inteiros little-endian. `str16` = u16 com o tamanho + bytes UTF-8. Pode vir sem compressão (atual)
ou inteiro dentro de um gzip (versões anteriores; começa com `1F 8B`).

    magic      8 bytes  "TLJPTBR\x01"
    versao     str16
    titulo     str16
    n_entradas u32
    entradas   n_entradas vezes:
      tipo     u8       1 = arquivo .xarc  |  2 = arquivo inteiro (ex.: chapters.ini, language.ini)
      caminho  str16    relativo à pasta do jogo, com "/"

    tipo 1 (.xarc):
      sha1_original   20 bytes  + tamanho u32
      sha1_resultado  20 bytes  + tamanho u32
      n_nos           u32       nós da árvore .xrc (conferência de estrutura)
      n_edicoes       u32, e para cada edição:
        no u32 (índice em pré-ordem) | tipo u8 | subtipo u8 | op u8 | aux u32 | crc_orig u32 | crc_mantido u32
        payload: u32 + bytes (texto em cp1252)
        op 1 = fala (t29): troca o texto u16+bytes do início dos dados e mantém o resto (crc_mantido)
        op 2 = texto de imagem (t13/s4): troca o texto u16+bytes no offset aux; mantém cabeçalho e final
        op 3 = nome do nó (ex.: nome que aparece ao passar o mouse)
        op 4 = dados inteiros do nó (ajustes de layout)

    tipo 2 (arquivo inteiro):
      sha1_original 20 bytes | sha1_resultado 20 bytes | conteudo: u32 + bytes

Aplicação: se o arquivo do jogo for o original (sha1), o resultado tem de bater com sha1_resultado.
Se já for o resultado, nada muda. Caso contrário (outra versão da tradução), aplica com as conferências de
tipo/estrutura/CRC e informa se o resultado não ficou idêntico.
