import { t, getLocale, translate } from './i18n.js';
// Shared by default rules, list filters, icons and expression groups.
// Ambiguous suffixes have one meaning here: .ts is source, .obj is a 3D model.
export const FILE_TYPES = [
  {
    id: 'document',
    name: '文档',
    icon: 'file',
    extensions:
      'pdf doc docx docm dot dotx dotm rtf odt ott pages xls xlsx xlsm xlsb xlt xltx xltm ods ots numbers ppt pptx pptm pot potx potm pps ppsx ppsm odp otp key txt md markdown rst tex csv tsv',
  },
  {
    id: 'image',
    name: '图片',
    icon: 'image',
    extensions:
      'jpg jpeg jpe jfif png apng gif webp svg svgz heic heif avif bmp dib ico icns tif tiff raw dng cr2 cr3 nef nrw arw sr2 orf rw2 raf pef ppm pgm pbm hdr exr jxl',
  },
  {
    id: 'archive',
    name: '压缩包',
    icon: 'archive',
    extensions:
      'zip zipx rar 7z tar gz gzip bz bz2 bzip2 xz z zst zstd lz lzma lz4 lzh cab arj tgz tbz tbz2 txz tzst tar.gz tar.bz2 tar.xz tar.zst',
  },
  {
    id: 'installer',
    name: '安装包',
    icon: 'app',
    extensions:
      'apk aab apks apkm xapk ipa dmg pkg exe msi msix msixbundle appx appxbundle deb rpm appimage crx vsix xpi',
  },
  {
    id: 'audio',
    name: '音频',
    icon: 'play',
    extensions:
      'mp3 wav wave flac m4a aac ogg oga opus wma aiff aif aifc amr ape alac mid midi mka caf',
  },
  {
    id: 'video',
    name: '视频',
    icon: 'play',
    extensions:
      'mp4 mov mkv webm avi m4v mpeg mpg mpe wmv flv f4v 3gp 3g2 m2ts mts vob ogv mxf m3u8 mpd',
  },
  {
    id: 'ebook',
    name: '电子书',
    icon: 'file',
    extensions: 'epub mobi azw azw3 azw4 fb2 djvu djv cbz cbr cbt',
  },
  {
    id: 'design',
    name: '设计文件',
    icon: 'image',
    extensions:
      'psd psb ai eps sketch fig xd afdesign afphoto afpub indd idml aep aepx prproj drp procreate cdr xcf kra',
  },
  { id: 'font', name: '字体', icon: 'file', extensions: 'ttf otf ttc otc woff woff2 eot pfb pfm' },
  { id: 'subtitle', name: '字幕', icon: 'file', extensions: 'srt ass ssa vtt sub sbv lrc scc' },
  {
    id: 'code',
    name: '代码',
    icon: 'file',
    extensions:
      'js mjs cjs jsx ts tsx vue svelte html htm css scss sass less py ipynb r rb php go rs c h cpp cc cxx hpp java kt kts swift m mm dart lua sh bash zsh fish ps1 bat cmd sql graphql gql proto wasm patch diff jar whl gem',
  },
  {
    id: 'data',
    name: '数据与配置',
    icon: 'file',
    extensions:
      'json jsonl ndjson yaml yml xml toml ini conf config env properties parquet arrow feather avro orc h5 hdf5 npy npz mat sav dta rds rdata db sqlite sqlite3 db3 sqlitedb',
  },
  {
    id: 'model',
    name: '模型与 CAD',
    icon: 'box',
    extensions:
      'blend fbx obj glb gltf stl 3mf ply usdz usd usdc usda dae 3ds max c4d dwg dxf step stp iges igs skp sldprt sldasm',
  },
  {
    id: 'disk',
    name: '磁盘镜像',
    icon: 'archive',
    extensions: 'iso img vhd vhdx vmdk qcow qcow2 vdi ova ovf vma',
  },
  { id: 'torrent', name: '种子', icon: 'download', extensions: 'torrent' },
  {
    id: 'personal',
    name: '邮件与日程',
    icon: 'file',
    extensions: 'eml msg mbox ics ical icalendar vcf vcard',
  },
].map((type) => ({ ...type, extensions: type.extensions.split(' ') }));
export const TYPE_BY_ID = Object.fromEntries(FILE_TYPES.map((type) => [type.id, type]));
export function classifyFile(filename) {
  const name = String(filename || '')
    .split(/[\\/]/)
    .pop()
    .toLowerCase();
  return FILE_TYPES.find((type) => type.extensions.some((ext) => name.endsWith('.' + ext)));
}

// Keep the original five IDs and destinations so existing downloads stay familiar.
export function defaultRules(locale = getLocale()) {
  const definitions = [
    ['documents', 'document'],
    ['images', 'image'],
    ['archives', 'archive'],
    ['installers', 'installer'],
    ['media', 'audio', 'video'],
    ...FILE_TYPES.slice(6).map((type) => ['builtin-' + type.id, type.id]),
  ];
  return definitions.map(([id, ...types]) => ({
    id,
    name: translate(locale, id === 'media' ? '音视频' : TYPE_BY_ID[types[0]].name),
    extensions: types.flatMap((type) => TYPE_BY_ID[type].extensions).join(', '),
    folder:
      translate(locale, id === 'media' ? '音视频' : TYPE_BY_ID[types[0]].name) + '/{year}-{month}',
    enabled: true,
    domain: '',
    keyword: '',
    regex: '',
  }));
}
const defaultFolders = new Map(
  defaultRules('zh-CN').map((rule) => [rule.id, rule.folder.replace('/{year}-{month}', '')]),
);
const dateFolders = { none: '', month: '{year}-{month}', day: '{year}-{month}-{day}' };
function folderForLayout(folder, { byType, date, order }) {
  const parts = [byType ? folder : '', dateFolders[date]];
  if (order === 'date-first') parts.reverse();
  return parts.filter(Boolean).join('/');
}
export function defaultRuleLayout(rule) {
  const base = defaultFolders.get(rule.id);
  if (!base || rule.pathTemplate || rule.action === 'keep') return null;
  for (const folder of [base, translate('en', base)])
    for (const byType of [true, false])
      for (const date of Object.keys(dateFolders))
        for (const order of ['type-first', 'date-first']) {
          const layout = { byType, date, order };
          if (rule.folder === folderForLayout(folder, layout)) return layout;
        }
  return null;
}
export function setDefaultFolderLayout(rules, layout) {
  if (
    !layout ||
    ![true, false, null].includes(layout.byType) ||
    ![null, ...Object.keys(dateFolders)].includes(layout.date) ||
    ![null, 'type-first', 'date-first'].includes(layout.order)
  )
    throw new Error(t('请选择有效的分类方式'));
  return rules.map((rule) => {
    const current = defaultRuleLayout(rule);
    if (!current) return rule;
    const next = Object.fromEntries(
      Object.keys(current).map((key) => [key, layout[key] ?? current[key]]),
    );
    return {
      ...rule,
      folder: folderForLayout(
        [defaultFolders.get(rule.id), translate('en', defaultFolders.get(rule.id))].find((folder) =>
          rule.folder.split('/').includes(folder),
        ) ||
          (rule.name === translate('en', defaultFolders.get(rule.id))
            ? translate('en', defaultFolders.get(rule.id))
            : defaultFolders.get(rule.id)),
        next,
      ),
    };
  });
}
