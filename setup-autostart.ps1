# 开机自启设置脚本 — 以管理员身份运行
# 设置两个代理开机自启（隐藏窗口）

$scripts = @(
    @{Name="CC DeepSeek Proxy";  Path="$env:USERPROFILE\ccswitch-deepseek\start-hidden.vbs"},
    @{Name="CC OpenCode Proxy"; Path="$env:USERPROFILE\ccswitch-deepseek-opencode\start-hidden.vbs"}
)

foreach ($s in $scripts) {
    $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$($s.Path)`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $trigger.Delay = "PT30S"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden:$true

    Register-ScheduledTask -TaskName $s.Name -Action $action -Trigger $trigger -Settings $settings -Force

    Write-Host "已设置: $($s.Name) → $($s.Path)"
}

Write-Host ""
Write-Host "完成！两个代理将在下次登录后 30 秒自动启动。"
Write-Host "任务可在「任务计划程序」中查看和修改。"
