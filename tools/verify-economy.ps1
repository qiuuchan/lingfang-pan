# LingFang M5 插件经济闭环验证脚本（PowerShell）。
#
# 前置：服务端运行中（127.0.0.1:8787）、迁移 0003 已应用、PLATFORM_ADMIN_EMAIL 已配置。
# 覆盖：钱包初始余额 → 发布定价 → 平台审核 → 购买结算（扣款/加款/流水）→ 幂等 → 余额不足 → 自购拦截 → 付费未购安装拦截 → 安装。
#
# 不依赖 LLM：插件数据用 docker psql 直接插入（绕过 LLM 生成），其余全走真实 HTTP API。
# 用法：pwsh tools/verify-economy.ps1

$ErrorActionPreference = 'Stop'
$base = $env:LINGFANG_API ; if (-not $base) { $base = 'http://127.0.0.1:8787' }
$fail = 0

function Api($method, $path, $body, $token) {
  $headers = @{}
  if ($token) { $headers['Authorization'] = "Bearer $token" }
  $json = if ($null -ne $body) { $body | ConvertTo-Json -Depth 10 } else { $null }
  return Invoke-RestMethod -Method $method -Uri "$base$path" -Headers $headers -ContentType 'application/json' -Body $json
}

# 期望调用失败并返回指定错误码（HTTP 4xx，响应体 { error })。
function ApiExpectError($method, $path, $body, $token, $expectCode) {
  try {
    Api $method $path $body $token | Out-Null
    return $null  # 不该成功
  } catch {
    $resp = $_.ErrorDetails.Message
    try { return ($resp | ConvertFrom-Json).error } catch { return "<非JSON: $resp>" }
  }
}

function Psql($sql) {
  docker compose exec -T postgres psql -U lingfang -d lingfang -t -A -c $sql 2>&1
}

function Check($name, $cond) {
  if ($cond) { Write-Output "  [OK] $name" }
  else { Write-Output "  [FAIL] $name"; $script:fail++ }
}

Write-Output "== 健康检查 =="
if ((Api GET '/health' $null $null).status -ne 'ok') { throw "服务端未就绪" }

$rnd = Get-Random
$sellerEmail = "seller$rnd@lingfang.local"
$buyerEmail  = "buyer$rnd@lingfang.local"

Write-Output "== 注册作者与买家，各建租户 =="
Api POST '/auth/register' @{ email = $sellerEmail; password = 'password123'; display_name = '作者' } $null | Out-Null
Api POST '/auth/register' @{ email = $buyerEmail;  password = 'password123'; display_name = '买家' } $null | Out-Null
$sellerLogin = Api POST '/auth/login' @{ email = $sellerEmail; password = 'password123' } $null
$buyerLogin  = Api POST '/auth/login' @{ email = $buyerEmail;  password = 'password123' } $null
$sellerT = Api POST '/tenants' @{ name = 'SellerCo'; slug = "seller$rnd" } $sellerLogin.token
$buyerT  = Api POST '/tenants' @{ name = 'BuyerCo';  slug = "buyer$rnd" }  $buyerLogin.token

Write-Output "== 钱包初始余额（应各 1000）=="
$sw = Api GET '/wallet' $null $sellerT.token
$bw = Api GET '/wallet' $null $buyerT.token
Check "作者初始余额 1000" ($sw.balance_cents -eq 1000)
Check "买家初始余额 1000" ($bw.balance_cents -eq 1000)
Check "买家有 signup_bonus 流水" (($bw.transactions | Where-Object { $_.reason -eq 'signup_bonus' }).Count -ge 1)

# 取作者 user_id / tenant_id，用 SQL 直接造插件（绕过 LLM 生成）。
$sellerUid = $sellerLogin.user_id
$sellerTid = $sellerT.tenant.id
$paidId = "paid-$rnd"
$freeId = "free-$rnd"
$dearId = "dear-$rnd"  # 超高价，用于余额不足

Write-Output "== SQL 造插件：付费(已审核) / 免费(待审核) / 超高价(已审核) =="
# 付费插件：500 分，已审核通过
Psql "INSERT INTO plugins (id,name,version,description,author_tenant_id,author_user_id,runtime_type,entry,marketplace,review_status,price_cents,status) VALUES ('$paidId','付费插件','1.0.0','一个付费插件','$sellerTid','$sellerUid','client','ui/index.html',true,'approved',500,'listed');" | Out-Null
# 免费插件：0 分，待审核（用于审核流程）
Psql "INSERT INTO plugins (id,name,version,description,author_tenant_id,author_user_id,runtime_type,entry,marketplace,review_status,price_cents,status) VALUES ('$freeId','免费插件','1.0.0','一个免费插件','$sellerTid','$sellerUid','client','ui/index.html',true,'pending',0,'listed');" | Out-Null
# 超高价插件：5000 分（买家余额不足），已审核
Psql "INSERT INTO plugins (id,name,version,description,author_tenant_id,author_user_id,runtime_type,entry,marketplace,review_status,price_cents,status) VALUES ('$dearId','贵插件','1.0.0','买不起','$sellerTid','$sellerUid','client','ui/index.html',true,'approved',5000,'listed');" | Out-Null

Write-Output "== 市场搜索：仅含已审核插件 =="
$search = Api GET '/marketplace/search?q=插件&sort=recent' $null $buyerT.token
$searchIds = $search.plugins | ForEach-Object { $_.id }
Check "搜索含已审核付费插件" ($searchIds -contains $paidId)
Check "搜索不含待审核免费插件" (-not ($searchIds -contains $freeId))
$paidCard = $search.plugins | Where-Object { $_.id -eq $paidId }
Check "付费插件 price_cents=500" ($paidCard.price_cents -eq 500)
Check "付费插件 is_free=false" ($paidCard.is_free -eq $false)

Write-Output "== 详情：未购买的付费插件 purchased=false =="
$detail = Api GET "/marketplace/plugins/$paidId" $null $buyerT.token
Check "未购买 purchased=false" ($detail.purchased -eq $false)

Write-Output "== 付费未购买直接安装 → payment_required =="
$code = ApiExpectError POST '/marketplace/install' @{ plugin_id = $paidId } $buyerT.token
Check "拦截未购买安装 (payment_required)" ($code -eq 'payment_required')

Write-Output "== 自购拦截：作者购买自己的插件 → bad_request =="
$code = ApiExpectError POST '/wallet/purchase' @{ plugin_id = $paidId } $sellerT.token
Check "拦截自购 (bad_request)" ($code -eq 'bad_request')

Write-Output "== 余额不足：买家购买 5000 分插件 → insufficient_balance =="
$code = ApiExpectError POST '/wallet/purchase' @{ plugin_id = $dearId } $buyerT.token
Check "拦截余额不足 (insufficient_balance)" ($code -eq 'insufficient_balance')

Write-Output "== 购买付费插件（500 分）=="
$buy = Api POST '/wallet/purchase' @{ plugin_id = $paidId } $buyerT.token
Check "购买成功 status=purchased" ($buy.status -eq 'purchased')
Check "购买后买家余额 500" ($buy.balance_cents -eq 500)

Write-Output "== 结算核对：买家 -500、作者 +500、流水正确 =="
$bw2 = Api GET '/wallet' $null $buyerT.token
$sw2 = Api GET '/wallet' $null $sellerT.token
Check "买家余额 500" ($bw2.balance_cents -eq 500)
Check "作者余额 1500" ($sw2.balance_cents -eq 1500)
Check "买家有 purchase(debit) 流水" (($bw2.transactions | Where-Object { $_.reason -eq 'purchase' -and $_.direction -eq 'debit' -and $_.amount_cents -eq 500 }).Count -eq 1)
Check "作者有 sale(credit) 流水" (($sw2.transactions | Where-Object { $_.reason -eq 'sale' -and $_.direction -eq 'credit' -and $_.amount_cents -eq 500 }).Count -eq 1)

Write-Output "== 购买幂等：再次购买 → already_purchased，不重复扣费 =="
$buy2 = Api POST '/wallet/purchase' @{ plugin_id = $paidId } $buyerT.token
Check "重复购买 already_purchased" ($buy2.status -eq 'already_purchased')
$bw3 = Api GET '/wallet' $null $buyerT.token
Check "重复购买后余额仍 500（未重复扣费）" ($bw3.balance_cents -eq 500)

Write-Output "== 已购后安装成功 =="
$inst = Api POST '/marketplace/install' @{ plugin_id = $paidId } $buyerT.token
Check "已购插件安装成功" ($inst.status -eq 'installed')

Write-Output "== 详情：已购买 purchased=true =="
$detail2 = Api GET "/marketplace/plugins/$paidId" $null $buyerT.token
Check "已购买 purchased=true" ($detail2.purchased -eq $true)

Write-Output "== 平台审核：标记买家为审核员（测试 PlatformAdmin 鉴权）→ 待审列表 → 通过 =="
# seed 对真实邮箱 1503255237@qq.com 的标记已在迁移后单独核对；此处用测试用户验证审核端点功能，
# 避免依赖真实账户的未知密码。临时标记买家为 platform_admin，验证后清理时一并删除该用户。
$buyerUid = $buyerLogin.user_id
Psql "UPDATE users SET is_platform_admin=true WHERE id='$buyerUid';" | Out-Null
# 重新登录拿到带 is_platform_admin 的响应（验证 login 回传该字段）。
$adminLogin = Api POST '/auth/login' @{ email = $buyerEmail; password = 'password123' } $null
Check "login 回传 is_platform_admin=true" ($adminLogin.is_platform_admin -eq $true)
# 用买家的租户 token 调审核端点（PlatformAdmin extractor 以 DB 标记为准，与租户正交）。
$pending = Api GET '/admin/review/pending' $null $buyerT.token
$pendingIds = $pending.plugins | ForEach-Object { $_.id }
Check "待审列表含免费插件" ($pendingIds -contains $freeId)
# 非审核员访问审核端点 → forbidden（作者未标记）。
$code = ApiExpectError GET '/admin/review/pending' $null $sellerT.token
Check "非审核员访问审核端点被拒 (forbidden)" ($code -eq 'forbidden')
Api POST '/admin/review/approve' @{ plugin_id = $freeId } $buyerT.token | Out-Null
$search2 = Api GET '/marketplace/search?q=免费&sort=recent' $null $buyerT.token
Check "审核通过后市场可见" (($search2.plugins | ForEach-Object { $_.id }) -contains $freeId)

Write-Output "== 免费插件直接安装（无需购买）=="
$instFree = Api POST '/marketplace/install' @{ plugin_id = $freeId } $buyerT.token
Check "免费插件直接安装成功" ($instFree.status -eq 'installed')

Write-Output ""
Write-Output "== 清理测试数据 =="
# 删测试插件相关数据（外键顺序：先依赖表）。
foreach ($plg in @($paidId, $freeId, $dearId)) {
  Psql "DELETE FROM wallet_transactions WHERE plugin_id='$plg';" | Out-Null
  Psql "DELETE FROM purchases WHERE plugin_id='$plg';" | Out-Null
  Psql "DELETE FROM plugin_installations WHERE plugin_id='$plg';" | Out-Null
  Psql "DELETE FROM plugins WHERE id='$plg';" | Out-Null
}
# 删测试用户及其租户（membership/wallet/tx 先删）。
foreach ($em in @($sellerEmail, $buyerEmail)) {
  $uid = Psql "SELECT id FROM users WHERE email='$em';"
  $uid = ($uid | Select-Object -First 1).Trim()
  if ($uid) {
    Psql "DELETE FROM wallet_transactions WHERE user_id='$uid' OR counterparty_user_id='$uid';" | Out-Null
    Psql "DELETE FROM purchases WHERE buyer_user_id='$uid' OR seller_user_id='$uid';" | Out-Null
    Psql "DELETE FROM plugin_installations WHERE installed_by='$uid';" | Out-Null
    Psql "DELETE FROM wallets WHERE user_id='$uid';" | Out-Null
    Psql "DELETE FROM memberships WHERE user_id='$uid';" | Out-Null
    Psql "DELETE FROM tenants WHERE owner_user_id='$uid';" | Out-Null
    Psql "DELETE FROM users WHERE id='$uid';" | Out-Null
  }
}
Write-Output "  测试数据已清理"

Write-Output ""
if ($fail -eq 0) { Write-Output "经济闭环验证全部通过 [OK]" }
else { Write-Output "存在 $fail 项失败 [FAIL]"; exit 1 }
