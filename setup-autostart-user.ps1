# 开机自启设置脚本 — 普通权限即可运行
# 把快捷方式放到启动文件夹（无需管理员）

$wshell = New-Object -ComObject WScript.Shell
$startup = [Environment]::GetFolderPath("Startup")

$scripts = @(
    @{Name="CC DeepSeek Proxy";  Path="$env:USERPROFILE\\ccswitch-deepseek\\start.bat"},
    @{Name="CC OpenCode Proxy"; Path="$env:USERPROFILE\\ccswitch-deepseek-opencode\\start.bat"}
)

foreach ($s in $scripts) {
    $lnk = $wshell.CreateShortcut("$startup\\$($s.Name).lnk")
    $lnk.TargetPath = "powershell.exe"
    $lnk.Arguments = "-WindowStyle Hidden -Command `"& '$($s.Path)'`""
    $lnk.WindowStyle = 7
    $lnk.Description = $s.Name
    $lnk.Save()
    Write-Host "已添加到启动文件夹: $($s.Name)"
}

Write-Host ""
Write-Host "完成！下次开机自动启动，无窗口。"
Write-Host "路径: $startup"
