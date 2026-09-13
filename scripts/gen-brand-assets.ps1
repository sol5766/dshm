# gen-brand-assets.ps1 —— 重新生成启动画面与应用图标资源（白底黑鲸鱼）
#
# 背景（2026-09-13 用户要求）：启动画面要「白底 + 黑鲸鱼」。
# 原资源的问题：
#   - start_window_icon.png（base）= 黑色圆角底板 #0A0A0D + 白色鲸鱼 → 白底上看起来
#     鲸鱼外面「有一圈黑的」；dark 变体是白鲸鱼（黑底上才成立）。
#   - AppScope 的分层应用图标 background.png 是纯黑 #0A0A0D，foreground.png 是白鲸鱼
#     → 桌面/Dock 图标同样是黑底板。
#   - dark 的 start_window_brand.png 是白色字标，放到白底启动图上等于看不见。
#
# 做法：以 logo_dark.png（透明底、黑色 #212327 鲸鱼）为唯一鲸鱼母版，
#   - 启动图图标 = 母版缩放到 256×256，透明底；
#   - 应用图标前景 = 母版缩放到画布 62% 居中（留出系统要求的安全区）；
#   - 应用图标背景 = 纯白；
#   - 品牌字标 dark 变体 = 复用 base 的黑色字标。
#
# 用法：pwsh -File scripts/gen-brand-assets.ps1
# 幂等：每次从 logo_dark.png 重新生成；原文件首次运行会备份到 .asset-backup/。

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repo = Split-Path -Parent $PSScriptRoot
$baseMedia = Join-Path $repo 'entry\src\main\resources\base\media'
$darkMedia = Join-Path $repo 'entry\src\main\resources\dark\media'
$appMedia = Join-Path $repo 'AppScope\resources\base\media'
$backupDir = Join-Path $repo '.asset-backup'
$master = Join-Path $baseMedia 'logo_dark.png'

if (-not (Test-Path $master)) { throw "缺少鲸鱼母版: $master" }
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }

function Backup-Once([string]$path) {
  if (-not (Test-Path $path)) { return }
  $name = ($path.Substring($repo.Length + 1) -replace '[\\/]', '__')
  $dest = Join-Path $backupDir $name
  if (-not (Test-Path $dest)) { Copy-Item $path $dest }
}

function New-Canvas([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  return @($bmp, $g)
}

# 启动图图标：母版等比缩放到整幅 256×256（透明底、黑色鲸鱼）
function New-SplashIcon([string]$dest) {
  Backup-Once $dest
  $src = [System.Drawing.Image]::FromFile($master)
  try {
    $r = New-Canvas 256
    $bmp = $r[0]; $g = $r[1]
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, 256, 256)))
    $g.Dispose()
    $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  } finally { $src.Dispose() }
  Write-Host "[brand] 启动图图标 -> $dest"
}

# 应用图标前景：母版缩放到画布 62% 居中（透明底）
function New-IconForeground([string]$dest, [int]$size = 512, [double]$ratio = 0.62) {
  Backup-Once $dest
  $src = [System.Drawing.Image]::FromFile($master)
  try {
    $r = New-Canvas $size
    $bmp = $r[0]; $g = $r[1]
    $inner = [int]($size * $ratio)
    $off = [int](($size - $inner) / 2)
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle($off, $off, $inner, $inner)))
    $g.Dispose()
    $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  } finally { $src.Dispose() }
  Write-Host "[brand] 应用图标前景 -> $dest"
}

# 应用图标背景：纯白
function New-IconBackground([string]$dest, [int]$size = 512) {
  Backup-Once $dest
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::White)
  $g.Dispose()
  $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "[brand] 应用图标背景（白） -> $dest"
}

New-SplashIcon (Join-Path $baseMedia 'start_window_icon.png')
New-SplashIcon (Join-Path $darkMedia 'start_window_icon.png')

# 深色启动图的字标改成黑色母版（白底上可见）
$brandBase = Join-Path $baseMedia 'start_window_brand.png'
$brandDark = Join-Path $darkMedia 'start_window_brand.png'
Backup-Once $brandDark
Copy-Item $brandBase $brandDark -Force
Write-Host "[brand] 启动图字标(dark) <- base 黑色字标"

foreach ($dir in @($appMedia, $baseMedia)) {
  New-IconBackground (Join-Path $dir 'background.png')
  New-IconForeground (Join-Path $dir 'foreground.png')
}

Write-Host '[brand] 完成。备份位于 .asset-backup/'
