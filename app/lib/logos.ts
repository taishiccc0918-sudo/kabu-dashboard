// 企業ロゴ用: 証券コード → 公式ドメインのマップ。
// favicon(google s2)/logo.dev でロゴを引くのに使う。
// 自信のある主要銘柄のみ記載。未登録の銘柄はイニシャル色チップにフォールバックする
// （間違ったドメインだと別企業のロゴが出てしまうため、確実なものだけを入れる方針）。
export const COMPANY_DOMAIN: Record<string, string> = {
  '7203': 'toyota.jp',
  '8306': 'mufg.jp',
  '8058': 'mitsubishicorp.com',
  '6758': 'sony.com',
  '6861': 'keyence.co.jp',
  '6954': 'fanuc.co.jp',
  '6762': 'tdk.com',
  '6501': 'hitachi.co.jp',
  '6503': 'mitsubishielectric.co.jp',
  '7011': 'mhi.com',
  '7974': 'nintendo.co.jp',
  '9684': 'square-enix.com',
  '9766': 'konami.com',
  '7936': 'asics.com',
  '7453': 'muji.com',
  '8136': 'sanrio.co.jp',
  '6273': 'smcworld.com',
  '4062': 'ibiden.co.jp',
  '6383': 'daifuku.com',
  '6701': 'nec.com',
  '5803': 'fujikura.co.jp',
  '4186': 'tok.co.jp',
  '7832': 'bandainamco.co.jp',
  '3635': 'koeitecmo.co.jp',
  '7245': 'daidometal.com',
  '6890': 'ferrotec.co.jp',
  '3433': 'tocalo.co.jp',
  '4204': 'sekisui.co.jp',
  '4043': 'tokuyama.co.jp',
  '4046': 'osaka-soda.co.jp',
  '4980': 'dexerials.jp',
  '9722': 'fujita-kanko.co.jp',
  '9616': 'kyoritsugroup.co.jp',
  '7550': 'zensho.co.jp',
  '3563': 'food-and-life.co.jp',
  '9468': 'kadokawa.co.jp',
  '5253': 'cover-corp.com',
  '3993': 'pkshatech.com',
  '3697': 'shiftinc.jp',
  '6113': 'amada.co.jp',
  '6368': 'organo.co.jp',
  '7721': 'tokyo-keiki.co.jp',
  '285A': 'kioxia.com',
  '6946': 'avio.co.jp',
  '7906': 'yonex.co.jp',
  '6814': 'furuno.co.jp',
  '7552': 'happinet.co.jp',
  '6331': 'kakoki.co.jp',
  '4902': 'konicaminolta.com',
  '8111': 'goldwin.co.jp',
  '7003': 'mes.co.jp',
  '7014': 'namura.co.jp',
  '7760': 'imv.co.jp',
  '5032': 'anycolor.co.jp',
  '4180': 'appier.com',
}

// ロゴ画像URL（Google s2 favicon。ドメイン未登録なら null）。
// sz は要求サイズ（64/128 など）。実体は各社の favicon＝多くはロゴマーク。
export function logoUrl(code: string, sz = 64): string | null {
  const d = COMPANY_DOMAIN[code]
  return d ? `https://www.google.com/s2/favicons?domain=${d}&sz=${sz}` : null
}

export function hasLogo(code: string): boolean {
  return code in COMPANY_DOMAIN
}
