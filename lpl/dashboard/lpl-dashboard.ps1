param(
  [string]$RootPath,
  [switch]$SmokeTest,
  [switch]$UiSmokeTest,
  [switch]$UiShowSmokeTest
)

if ([string]::IsNullOrWhiteSpace($RootPath)) {
  $RootPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
} else {
  $RootPath = (Resolve-Path -LiteralPath $RootPath).Path
}

$LplPath = Join-Path $RootPath 'lpl'
$AnalysisPath = Join-Path $LplPath 'data\盘口分析'
$InsightJsonPath = Join-Path $AnalysisPath '队伍模型洞察.json'
$InsightCsvPath = Join-Path $AnalysisPath '队伍模型洞察.csv'
$GroupJsonPath = Join-Path $AnalysisPath '队伍分组识别.json'
$ProfileCsvPath = Join-Path $AnalysisPath '队伍盘口命中率.csv'
$ReportPath = Join-Path $AnalysisPath 'LPL盘口报告.md'
$ErrorLogPath = Join-Path $AnalysisPath 'dashboard-error.log'

function Write-DashboardError {
  param($ErrorObject)
  $exceptionText = if ($ErrorObject.Exception) { $ErrorObject.Exception.ToString() } else { [string]$ErrorObject }
  $message = "[$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))] $ErrorObject`r`n$exceptionText`r`n$($ErrorObject.ScriptStackTrace)`r`n"
  try {
    Add-Content -LiteralPath $ErrorLogPath -Encoding UTF8 -Value $message
  } catch {
    Write-Error $message
  }
}

function Run-ProcessCapture {
  param([string]$FileName, [string]$Arguments)

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FileName
  $psi.Arguments = $Arguments
  $psi.WorkingDirectory = $RootPath
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  [void]$process.Start()
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()

  return [pscustomobject]@{
    ExitCode = $process.ExitCode
    Output = (($stdout, $stderr) -join "`r`n").Trim()
  }
}

function Export-Insights {
  $result = Run-ProcessCapture -FileName 'node.exe' -Arguments 'lpl/dashboard/export-team-insights.js'
  if ($result.ExitCode -ne 0) {
    throw "队伍洞察生成失败: $($result.Output)"
  }
  return $result.Output
}

function Load-Insights {
  if (-not (Test-Path -LiteralPath $InsightJsonPath)) {
    [void](Export-Insights)
  }
  return (Get-Content -LiteralPath $InsightJsonPath -Encoding UTF8 -Raw | ConvertFrom-Json)
}

if ($SmokeTest) {
  $out = Export-Insights
  $insight = Load-Insights
  $top = $insight.teams | Select-Object -First 1
  Write-Output $out
  Write-Output "teams=$($insight.team_count), top=$($top.team_id), rating=$($top.strength_score), tier=$($top.tier)"
  exit 0
}

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Xaml
Add-Type -AssemblyName System.Data

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="LPL Team Model Studio"
        Width="1380" Height="880" MinWidth="1180" MinHeight="720"
        WindowStartupLocation="CenterScreen"
        Background="#0B1120"
        FontFamily="Microsoft YaHei UI"
        TextOptions.TextFormattingMode="Display">
  <Window.Resources>
    <SolidColorBrush x:Key="PanelBrush" Color="#111827"/>
    <SolidColorBrush x:Key="Panel2Brush" Color="#172033"/>
    <SolidColorBrush x:Key="TextBrush" Color="#E5E7EB"/>
    <SolidColorBrush x:Key="SubTextBrush" Color="#9CA3AF"/>
    <SolidColorBrush x:Key="AccentBrush" Color="#38BDF8"/>
    <SolidColorBrush x:Key="GreenBrush" Color="#22C55E"/>
    <SolidColorBrush x:Key="AmberBrush" Color="#F59E0B"/>
    <Style TargetType="Button">
      <Setter Property="Height" Value="34"/>
      <Setter Property="Padding" Value="14,4"/>
      <Setter Property="Margin" Value="6,0,0,0"/>
      <Setter Property="Background" Value="#1F2937"/>
      <Setter Property="Foreground" Value="#E5E7EB"/>
      <Setter Property="BorderBrush" Value="#334155"/>
      <Setter Property="FontSize" Value="13"/>
      <Setter Property="Cursor" Value="Hand"/>
    </Style>
    <Style TargetType="TextBox">
      <Setter Property="Height" Value="34"/>
      <Setter Property="Padding" Value="10,6"/>
      <Setter Property="Background" Value="#0F172A"/>
      <Setter Property="Foreground" Value="#E5E7EB"/>
      <Setter Property="BorderBrush" Value="#334155"/>
      <Setter Property="CaretBrush" Value="#38BDF8"/>
    </Style>
    <Style TargetType="ListBox">
      <Setter Property="Background" Value="#0F172A"/>
      <Setter Property="Foreground" Value="#E5E7EB"/>
      <Setter Property="BorderThickness" Value="0"/>
    </Style>
    <Style TargetType="ListBoxItem">
      <Setter Property="Padding" Value="0"/>
      <Setter Property="Margin" Value="0,0,0,8"/>
      <Setter Property="HorizontalContentAlignment" Value="Stretch"/>
      <Setter Property="Background" Value="Transparent"/>
    </Style>
    <Style TargetType="TabControl">
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="BorderThickness" Value="0"/>
    </Style>
    <Style TargetType="TabItem">
      <Setter Property="Padding" Value="16,8"/>
      <Setter Property="FontSize" Value="13"/>
      <Setter Property="Foreground" Value="#D1D5DB"/>
      <Setter Property="Background" Value="#111827"/>
    </Style>
    <Style TargetType="ListView">
      <Setter Property="Background" Value="#0F172A"/>
      <Setter Property="Foreground" Value="#E5E7EB"/>
      <Setter Property="BorderThickness" Value="0"/>
      <Setter Property="VirtualizingPanel.IsVirtualizing" Value="False"/>
      <Setter Property="FontSize" Value="12"/>
    </Style>
    <Style TargetType="ProgressBar">
      <Setter Property="Height" Value="8"/>
      <Setter Property="Minimum" Value="0"/>
      <Setter Property="Maximum" Value="100"/>
      <Setter Property="Foreground" Value="#38BDF8"/>
      <Setter Property="Background" Value="#253047"/>
    </Style>
  </Window.Resources>

  <Grid Margin="18">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="*"/>
      <RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>

    <Border Grid.Row="0" Background="#111827" BorderBrush="#1F2937" BorderThickness="1" CornerRadius="16" Padding="18">
      <Grid>
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <StackPanel>
          <TextBlock Text="LPL Team Model Studio" Foreground="#F9FAFB" FontSize="24" FontWeight="Bold"/>
          <TextBlock x:Name="HeaderStatus" Text="加载中..." Foreground="#9CA3AF" FontSize="13" Margin="0,6,0,0"/>
          <TextBlock x:Name="LeagueSummary" Text="" Foreground="#7DD3FC" FontSize="13" Margin="0,4,0,0"/>
        </StackPanel>
        <StackPanel Grid.Column="1" Orientation="Horizontal" VerticalAlignment="Center">
          <Button x:Name="RefreshButton" Content="刷新洞察"/>
          <Button x:Name="MarketsButton" Content="重跑盘口模型"/>
          <Button x:Name="FolderButton" Content="打开输出目录"/>
        </StackPanel>
      </Grid>
    </Border>

    <Grid Grid.Row="1" Margin="0,16,0,12">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="310"/>
        <ColumnDefinition Width="16"/>
        <ColumnDefinition Width="*"/>
      </Grid.ColumnDefinitions>

      <Border Grid.Column="0" Background="#111827" BorderBrush="#1F2937" BorderThickness="1" CornerRadius="16" Padding="14">
        <Grid>
          <Grid.RowDefinitions>
            <RowDefinition Height="Auto"/>
            <RowDefinition Height="Auto"/>
            <RowDefinition Height="*"/>
          </Grid.RowDefinitions>
          <TextBlock Text="队伍列表" Foreground="#F3F4F6" FontSize="17" FontWeight="Bold"/>
          <TextBox x:Name="SearchBox" Grid.Row="1" Margin="0,12,0,12" ToolTip="搜索队伍"/>
          <ListBox x:Name="TeamList" Grid.Row="2"/>
        </Grid>
      </Border>

      <TabControl x:Name="MainTabs" Grid.Column="2">
        <TabItem Header="队伍画像">
          <ScrollViewer VerticalScrollBarVisibility="Auto" Background="#0B1120">
            <StackPanel Margin="0,10,0,0">
              <Border Background="#111827" BorderBrush="#1F2937" BorderThickness="1" CornerRadius="16" Padding="18">
                <Grid>
                  <Grid.ColumnDefinitions>
                    <ColumnDefinition Width="*"/>
                    <ColumnDefinition Width="Auto"/>
                  </Grid.ColumnDefinitions>
                  <StackPanel>
                    <StackPanel Orientation="Horizontal">
                      <TextBlock x:Name="TeamNameText" Text="-" Foreground="#F9FAFB" FontSize="28" FontWeight="Bold"/>
                      <Border Background="#0EA5E9" CornerRadius="12" Padding="10,4" Margin="14,4,0,0">
                        <TextBlock x:Name="TierBadge" Text="-" Foreground="#00111F" FontWeight="Bold"/>
                      </Border>
                      <Border Background="#243044" CornerRadius="12" Padding="10,4" Margin="8,4,0,0">
                        <TextBlock x:Name="StyleBadge" Text="-" Foreground="#D1D5DB"/>
                      </Border>
                    </StackPanel>
                    <TextBlock x:Name="TeamMetaText" Text="" Foreground="#9CA3AF" FontSize="13" Margin="0,8,0,0"/>
                  </StackPanel>
                  <UniformGrid Grid.Column="1" Columns="4" Rows="1" Margin="24,0,0,0">
                    <StackPanel Margin="14,0">
                      <TextBlock Text="评级" Foreground="#9CA3AF" FontSize="12"/>
                      <TextBlock x:Name="RatingValue" Text="-" Foreground="#F9FAFB" FontSize="24" FontWeight="Bold"/>
                    </StackPanel>
                    <StackPanel Margin="14,0">
                      <TextBlock Text="排名" Foreground="#9CA3AF" FontSize="12"/>
                      <TextBlock x:Name="RankValue" Text="-" Foreground="#F9FAFB" FontSize="24" FontWeight="Bold"/>
                    </StackPanel>
                    <StackPanel Margin="14,0">
                      <TextBlock Text="置信度" Foreground="#9CA3AF" FontSize="12"/>
                      <TextBlock x:Name="ConfidenceValue" Text="-" Foreground="#F9FAFB" FontSize="24" FontWeight="Bold"/>
                    </StackPanel>
                    <StackPanel Margin="14,0">
                      <TextBlock Text="样本" Foreground="#9CA3AF" FontSize="12"/>
                      <TextBlock x:Name="SampleValue" Text="-" Foreground="#F9FAFB" FontSize="24" FontWeight="Bold"/>
                    </StackPanel>
                  </UniformGrid>
                </Grid>
              </Border>

              <UniformGrid Columns="2" Margin="0,16,0,0">
                <Border Background="#111827" BorderBrush="#1F2937" BorderThickness="1" CornerRadius="16" Padding="18" Margin="0,0,8,0">
                  <StackPanel>
                    <TextBlock Text="核心属性 / Core Attributes" Foreground="#F3F4F6" FontSize="16" FontWeight="Bold" Margin="0,0,0,14"/>
                    <Grid>
                      <Grid.ColumnDefinitions>
                        <ColumnDefinition Width="96"/>
                        <ColumnDefinition Width="*"/>
                        <ColumnDefinition Width="54"/>
                      </Grid.ColumnDefinitions>
                      <Grid.RowDefinitions>
                        <RowDefinition Height="30"/><RowDefinition Height="30"/><RowDefinition Height="30"/><RowDefinition Height="30"/>
                        <RowDefinition Height="30"/><RowDefinition Height="30"/><RowDefinition Height="30"/><RowDefinition Height="30"/>
                      </Grid.RowDefinitions>
                      <TextBlock Grid.Row="0" Text="强度" Foreground="#D1D5DB"/><ProgressBar x:Name="StrengthBar" Grid.Row="0" Grid.Column="1"/><TextBlock x:Name="StrengthText" Grid.Row="0" Grid.Column="2" Foreground="#E5E7EB" TextAlignment="Right"/>
                      <TextBlock Grid.Row="1" Text="节奏" Foreground="#D1D5DB"/><ProgressBar x:Name="TempoBar" Grid.Row="1" Grid.Column="1"/><TextBlock x:Name="TempoText" Grid.Row="1" Grid.Column="2" Foreground="#E5E7EB" TextAlignment="Right"/>
                      <TextBlock Grid.Row="2" Text="近期状态" Foreground="#D1D5DB"/><ProgressBar x:Name="MomentumBar" Grid.Row="2" Grid.Column="1"/><TextBlock x:Name="MomentumText" Grid.Row="2" Grid.Column="2" Foreground="#E5E7EB" TextAlignment="Right"/>
                      <TextBlock Grid.Row="3" Text="进攻" Foreground="#D1D5DB"/><ProgressBar x:Name="AttackBar" Grid.Row="3" Grid.Column="1"/><TextBlock x:Name="AttackText" Grid.Row="3" Grid.Column="2" Foreground="#E5E7EB" TextAlignment="Right"/>
                      <TextBlock Grid.Row="4" Text="防守" Foreground="#D1D5DB"/><ProgressBar x:Name="DefenseBar" Grid.Row="4" Grid.Column="1"/><TextBlock x:Name="DefenseText" Grid.Row="4" Grid.Column="2" Foreground="#E5E7EB" TextAlignment="Right"/>
                      <TextBlock Grid.Row="5" Text="前期" Foreground="#D1D5DB"/><ProgressBar x:Name="EarlyBar" Grid.Row="5" Grid.Column="1"/><TextBlock x:Name="EarlyText" Grid.Row="5" Grid.Column="2" Foreground="#E5E7EB" TextAlignment="Right"/>
                      <TextBlock Grid.Row="6" Text="资源" Foreground="#D1D5DB"/><ProgressBar x:Name="ObjectiveBar" Grid.Row="6" Grid.Column="1"/><TextBlock x:Name="ObjectiveText" Grid.Row="6" Grid.Column="2" Foreground="#E5E7EB" TextAlignment="Right"/>
                      <TextBlock Grid.Row="7" Text="波动" Foreground="#D1D5DB"/><ProgressBar x:Name="VolatilityBar" Grid.Row="7" Grid.Column="1"/><TextBlock x:Name="VolatilityText" Grid.Row="7" Grid.Column="2" Foreground="#E5E7EB" TextAlignment="Right"/>
                    </Grid>
                  </StackPanel>
                </Border>

                <Border Background="#111827" BorderBrush="#1F2937" BorderThickness="1" CornerRadius="16" Padding="18" Margin="8,0,0,0">
                  <StackPanel>
                    <TextBlock Text="模型解释 / Model Read" Foreground="#F3F4F6" FontSize="16" FontWeight="Bold" Margin="0,0,0,14"/>
                    <TextBlock x:Name="NoteText" TextWrapping="Wrap" Foreground="#E5E7EB" FontSize="14" LineHeight="23"/>
                    <TextBlock Text="风险标签" Foreground="#9CA3AF" FontSize="12" Margin="0,18,0,6"/>
                    <TextBlock x:Name="WarningText" TextWrapping="Wrap" Foreground="#FBBF24" FontSize="13"/>
                    <TextBlock Text="常用英雄池快照" Foreground="#9CA3AF" FontSize="12" Margin="0,18,0,6"/>
                    <TextBlock x:Name="HeroPoolText" TextWrapping="Wrap" Foreground="#CBD5E1" FontSize="13" LineHeight="21"/>
                  </StackPanel>
                </Border>
              </UniformGrid>

              <Border Background="#111827" BorderBrush="#1F2937" BorderThickness="1" CornerRadius="16" Padding="14" Margin="0,16,0,0">
                <StackPanel>
                  <TextBlock Text="详细指标 / Raw Model Inputs" Foreground="#F3F4F6" FontSize="16" FontWeight="Bold" Margin="4,0,0,10"/>
                  <ListView x:Name="MetricGrid" Height="260"/>
                </StackPanel>
              </Border>
            </StackPanel>
          </ScrollViewer>
        </TabItem>

        <TabItem Header="评级榜">
          <Border Background="#111827" BorderBrush="#1F2937" BorderThickness="1" CornerRadius="16" Padding="14" Margin="0,10,0,0">
            <ListView x:Name="RankingGrid"/>
          </Border>
        </TabItem>

        <TabItem Header="近期地图">
          <Border Background="#111827" BorderBrush="#1F2937" BorderThickness="1" CornerRadius="16" Padding="14" Margin="0,10,0,0">
            <ListView x:Name="RecentGrid"/>
          </Border>
        </TabItem>

        <TabItem Header="文件">
          <Border Background="#111827" BorderBrush="#1F2937" BorderThickness="1" CornerRadius="16" Padding="18" Margin="0,10,0,0">
            <StackPanel>
              <TextBlock Text="输出文件" Foreground="#F3F4F6" FontSize="18" FontWeight="Bold"/>
              <TextBlock x:Name="FileText" TextWrapping="Wrap" Foreground="#CBD5E1" FontSize="13" Margin="0,12,0,0" LineHeight="23"/>
              <TextBlock Text="说明" Foreground="#F3F4F6" FontSize="18" FontWeight="Bold" Margin="0,24,0,0"/>
              <TextBlock TextWrapping="Wrap" Foreground="#CBD5E1" FontSize="13" Margin="0,12,0,0" LineHeight="23"
                         Text="这个窗口展示的是模型内部状态，不是下注候选列表。评级高不等于能下注；下注仍必须经过 odds-core 闸门、赔率评估、严格筛选和资金规则。"/>
            </StackPanel>
          </Border>
        </TabItem>
      </TabControl>
    </Grid>

    <TextBlock x:Name="FooterStatus" Grid.Row="2" Text="" Foreground="#64748B" FontSize="12"/>
  </Grid>
</Window>
"@

$xml = [xml]$xaml
$reader = New-Object System.Xml.XmlNodeReader $xml
$window = [Windows.Markup.XamlReader]::Load($reader)

function Find-Control {
  param([string]$Name)
  return $window.FindName($Name)
}

$controls = @{}
@(
  'HeaderStatus','LeagueSummary','RefreshButton','MarketsButton','FolderButton','SearchBox','TeamList',
  'TeamNameText','TeamMetaText','TierBadge','StyleBadge','RatingValue','RankValue','ConfidenceValue','SampleValue',
  'StrengthBar','StrengthText','TempoBar','TempoText','MomentumBar','MomentumText','AttackBar','AttackText',
  'DefenseBar','DefenseText','EarlyBar','EarlyText','ObjectiveBar','ObjectiveText','VolatilityBar','VolatilityText',
  'NoteText','WarningText','HeroPoolText','MetricGrid','RankingGrid','RecentGrid','FileText','FooterStatus','MainTabs'
) | ForEach-Object { $controls[$_] = Find-Control $_ }

$script:Insight = $null
$script:Teams = @()

function Get-Prop {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return '' }
  $prop = $Object.PSObject.Properties[$Name]
  if ($null -eq $prop -or $null -eq $prop.Value) { return '' }
  return $prop.Value
}

function As-Number {
  param($Value)
  $number = 0.0
  if ([double]::TryParse([string]$Value, [ref]$number)) { return $number }
  return 0.0
}

function F1 {
  param($Value)
  return (As-Number $Value).ToString('F1')
}

function FPct {
  param($Value)
  return ((As-Number $Value) * 100).ToString('F1') + '%'
}

function To-DataTable {
  param([array]$Rows, [array]$Columns)
  $table = New-Object System.Data.DataTable
  foreach ($column in $Columns) {
    [void]$table.Columns.Add($column.Label)
  }
  foreach ($row in $Rows) {
    $dataRow = $table.NewRow()
    foreach ($column in $Columns) {
      $value = Get-Prop $row $column.Name
      if ($column.Format -eq 'f1') {
        $value = F1 $value
      } elseif ($column.Format -eq 'pct') {
        $value = FPct $value
      }
      $dataRow[$column.Label] = [string]$value
    }
    [void]$table.Rows.Add($dataRow)
  }
  return $table
}

function Set-Grid {
  param($Grid, [array]$Rows, [array]$Columns)
  $Grid.ItemsSource = $null
  $view = New-Object System.Windows.Controls.GridView
  foreach ($column in $Columns) {
    $gridColumn = New-Object System.Windows.Controls.GridViewColumn
    $gridColumn.Header = $column.Label
    $gridColumn.Width = if ($column.Width) { [double]$column.Width } else { [double]130 }
    $binding = New-Object System.Windows.Data.Binding
    $binding.Path = "[$($column.Label)]"
    $gridColumn.DisplayMemberBinding = $binding
    [void]$view.Columns.Add($gridColumn)
  }
  $Grid.View = $view
  $Grid.ItemsSource = (To-DataTable -Rows $Rows -Columns $Columns).DefaultView
}

function Set-Bar {
  param([string]$Prefix, $Value)
  $v = [math]::Max(0, [math]::Min(100, (As-Number $Value)))
  $controls["${Prefix}Bar"].Value = $v
  $controls["${Prefix}Text"].Text = $v.ToString('F1')
}

function New-TeamItem {
  param($Team)

  $item = New-Object System.Windows.Controls.ListBoxItem
  $item.Tag = $Team

  $border = New-Object System.Windows.Controls.Border
  $border.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#172033')
  $border.BorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#263449')
  $border.BorderThickness = New-Object System.Windows.Thickness(1)
  $border.CornerRadius = New-Object System.Windows.CornerRadius(12)
  $border.Padding = New-Object System.Windows.Thickness(12)

  $grid = New-Object System.Windows.Controls.Grid
  [void]$grid.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition))
  $col = New-Object System.Windows.Controls.ColumnDefinition
  $col.Width = [System.Windows.GridLength]::Auto
  [void]$grid.ColumnDefinitions.Add($col)

  $stack = New-Object System.Windows.Controls.StackPanel
  $name = New-Object System.Windows.Controls.TextBlock
  $name.Text = "$($Team.team_id)  $($Team.team)"
  $name.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#F3F4F6')
  $name.FontWeight = 'SemiBold'
  $name.FontSize = 14
  $meta = New-Object System.Windows.Controls.TextBlock
  $meta.Text = "$($Team.group_name) #$($Team.group_rank) · 跨组#$($Team.rank) · $($Team.tier)级 · $($Team.style_label)"
  $meta.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#9CA3AF')
  $meta.FontSize = 12
  $meta.Margin = New-Object System.Windows.Thickness(0,4,0,0)
  [void]$stack.Children.Add($name)
  [void]$stack.Children.Add($meta)

  $score = New-Object System.Windows.Controls.TextBlock
  $score.Text = [string]$Team.rating_score
  $score.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#38BDF8')
  $score.FontWeight = 'Bold'
  $score.FontSize = 18
  $score.VerticalAlignment = 'Center'
  [System.Windows.Controls.Grid]::SetColumn($score, 1)
  [void]$grid.Children.Add($stack)
  [void]$grid.Children.Add($score)
  $border.Child = $grid
  $item.Content = $border
  return $item
}

function Populate-TeamList {
  $query = ([string]$controls.SearchBox.Text).Trim().ToLowerInvariant()
  $controls.TeamList.Items.Clear()
  $teams = @($script:Teams | Where-Object {
    [string]::IsNullOrWhiteSpace($query) -or
    ([string]$_.team_id).ToLowerInvariant().Contains($query) -or
    ([string]$_.team).ToLowerInvariant().Contains($query)
  })
  foreach ($team in $teams) {
    [void]$controls.TeamList.Items.Add((New-TeamItem $team))
  }
  if ($controls.TeamList.Items.Count -gt 0) {
    $controls.TeamList.SelectedIndex = 0
  }
}

function Show-Team {
  param($Team)
  if ($null -eq $Team) { return }

  $controls.TeamNameText.Text = "$($Team.team_id)  $($Team.team)"
  $controls.TierBadge.Text = "$($Team.tier)级"
  $controls.StyleBadge.Text = "$($Team.group_name) · $($Team.style_label)"
  $controls.TeamMetaText.Text = "$($Team.group_name)组内第 $($Team.group_rank)/$($Team.group_size) · 跨组折算排名 #$($Team.rank) · 组内原始分 $(F1 $Team.group_internal_score) · 跨组修正 $(F1 $Team.group_adjustment) · 近5: $($Team.recent_5) · 当前版本 $($Team.current_patch) / $($Team.current_patch_maps) maps"
  $controls.RatingValue.Text = F1 $Team.rating_score
  $controls.RankValue.Text = "$($Team.group_name) #$($Team.group_rank)"
  $controls.ConfidenceValue.Text = "$(F1 $Team.confidence)%"
  $controls.SampleValue.Text = "$($Team.maps) maps"

  Set-Bar -Prefix 'Strength' -Value $Team.attributes.strength
  Set-Bar -Prefix 'Tempo' -Value $Team.attributes.tempo
  Set-Bar -Prefix 'Momentum' -Value $Team.attributes.momentum
  Set-Bar -Prefix 'Attack' -Value $Team.attributes.attack
  Set-Bar -Prefix 'Defense' -Value $Team.attributes.defense
  Set-Bar -Prefix 'Early' -Value $Team.attributes.early
  Set-Bar -Prefix 'Objective' -Value $Team.attributes.objective
  Set-Bar -Prefix 'Volatility' -Value $Team.attributes.volatility

  $controls.NoteText.Text = [string]$Team.model_note
  $warnings = @($Team.warnings)
  $controls.WarningText.Text = if ($warnings.Count) { $warnings -join ' / ' } else { '无明显样本风险标签。' }
  $heroPool = @($Team.hero_pool | ForEach-Object { "$($_.role): $($_.hero) x$($_.count)" })
  $controls.HeroPoolText.Text = if ($heroPool.Count) { $heroPool -join '    ' } else { '暂无英雄池数据。' }

  $metricRows = @(
    [pscustomobject]@{ metric = '组别'; value = "$($Team.group_name) #$($Team.group_rank)/$($Team.group_size)"; detail = 'LPL 第二赛段分组识别；跨组排名只作参考' },
    [pscustomobject]@{ metric = '跨组折算评级 rating_score'; value = F1 $Team.rating_score; detail = "组内原始分 $(F1 $Team.group_internal_score)，固定组别基线 $(F1 $Team.division_baseline_adjustment)，组均值微调 $(F1 $Team.group_mean_adjustment)" },
    [pscustomobject]@{ metric = '组内原始分 group_internal_score'; value = F1 $Team.group_internal_score; detail = '只能在本组内读，不能和另一个组同分比较' },
    [pscustomobject]@{ metric = '节奏评分 tempo_score'; value = F1 $Team.tempo_score; detail = '总击杀、死亡数、游戏时长、DPM 组合' },
    [pscustomobject]@{ metric = '样本置信度'; value = "$(F1 $Team.confidence)%"; detail = "maps=$($Team.maps), current_patch_maps=$($Team.current_patch_maps)" },
    [pscustomobject]@{ metric = '大场 / 小局胜率'; value = "$(FPct $Team.match_win_rate) / $(FPct $Team.map_win_rate)"; detail = 'Bayesian shrinkage 后值' },
    [pscustomobject]@{ metric = '近期加权小局胜率'; value = FPct $Team.recent_10_map_win_rate; detail = "有效近期样本 $($Team.recent_weighted_effective_maps)" },
    [pscustomobject]@{ metric = '均杀 / 均死 / 击杀差'; value = "$(F1 $Team.avg_kills) / $(F1 $Team.avg_deaths) / $(F1 $Team.avg_kill_diff)"; detail = '单地图口径' },
    [pscustomobject]@{ metric = '平均总击杀 / 平均时长'; value = "$(F1 $Team.avg_total_kills) / $(F1 $Team.avg_game_time_min)"; detail = '已做 patch 调整' },
    [pscustomobject]@{ metric = '前期 GD@15 / 首塔 / 一血'; value = "$(F1 $Team.gd_at_15) / $(FPct $Team.first_turret_rate) / $(FPct $Team.first_blood_rate)"; detail = '一血字段只作画像，不作为下注闸门' },
    [pscustomobject]@{ metric = '龙 / 先锋 / 男爵控制'; value = "$(FPct $Team.dragon_control_rate) / $(FPct $Team.herald_control_rate) / $(FPct $Team.baron_control_rate)"; detail = '资源控制画像' },
    [pscustomobject]@{ metric = '总击杀 over 27.5 / 30.5 / 33.5'; value = "$(FPct $Team.kill_over_27_5_rate) / $(FPct $Team.kill_over_30_5_rate) / $(FPct $Team.kill_over_33_5_rate)"; detail = '仅作属性参考，下注看连续总杀模型与 line_edge' }
  )
  Set-Grid -Grid $controls.MetricGrid -Rows $metricRows -Columns @(
    @{ Name = 'metric'; Label = '指标' },
    @{ Name = 'value'; Label = '值' },
    @{ Name = 'detail'; Label = '解释' }
  )

  Set-Grid -Grid $controls.RecentGrid -Rows @($Team.recent_maps) -Columns @(
    @{ Name = 'date'; Label = '日期' },
    @{ Name = 'result'; Label = '结果' },
    @{ Name = 'opponent'; Label = '对手' },
    @{ Name = 'kills'; Label = '击杀' },
    @{ Name = 'deaths'; Label = '死亡' },
    @{ Name = 'total_kills'; Label = '总击杀' },
    @{ Name = 'game_time_min'; Label = '时长' },
    @{ Name = 'patch'; Label = '版本' },
    @{ Name = 'side'; Label = '边' },
    @{ Name = 'match'; Label = '比赛' }
  )
}

function Refresh-Insights {
  param([bool]$RunMarkets = $false)

  try {
    $controls.FooterStatus.Text = '正在刷新...'
    if ($RunMarkets) {
      $market = Run-ProcessCapture -FileName 'npm.cmd' -Arguments 'run lpl:markets'
      if ($market.ExitCode -ne 0) { throw "盘口模型失败: $($market.Output)" }
    }
    [void](Export-Insights)
    $script:Insight = Load-Insights
    $script:Teams = @($script:Insight.teams)

    $groupSummary = @($script:Insight.grouping.groups | ForEach-Object { "$($_.name): $($_.size)队 / 均强度$($_.avg_strength_raw)" }) -join ' · '
    $controls.HeaderStatus.Text = "生成时间 $($script:Insight.generated_at) · 队伍 $($script:Insight.team_count) 支 · 已按登峰/涅槃分组"
    $controls.LeagueSummary.Text = "组别: $groupSummary · 跨组基线: 登峰 +2 / 涅槃 -5 · 联盟均值: 折算强度 $($script:Insight.league.avg_strength) / 原始强度 $($script:Insight.league.avg_raw_strength)"
    $controls.FileText.Text = "JSON: $InsightJsonPath`nCSV: $InsightCsvPath`nGroup: $GroupJsonPath`nProfile: $ProfileCsvPath`nReport: $ReportPath"

    Set-Grid -Grid $controls.RankingGrid -Rows @($script:Insight.ranking) -Columns @(
      @{ Name = 'rank'; Label = '#' },
      @{ Name = 'group_name'; Label = '组别' },
      @{ Name = 'group_rank'; Label = '组内' },
      @{ Name = 'team_id'; Label = '队伍' },
      @{ Name = 'tier'; Label = '级别' },
      @{ Name = 'style_label'; Label = '类型' },
      @{ Name = 'rating_score'; Label = '跨组评级' },
      @{ Name = 'group_internal_score'; Label = '组内分' },
      @{ Name = 'raw_strength_score'; Label = '原始分' },
      @{ Name = 'group_adjustment'; Label = '组别修正' },
      @{ Name = 'tempo_score'; Label = '节奏' },
      @{ Name = 'confidence'; Label = '置信度' },
      @{ Name = 'maps'; Label = 'Maps' },
      @{ Name = 'current_patch_maps'; Label = '当前版本' },
      @{ Name = 'attack'; Label = '进攻' },
      @{ Name = 'defense'; Label = '防守' },
      @{ Name = 'early'; Label = '前期' },
      @{ Name = 'objective'; Label = '资源' },
      @{ Name = 'volatility'; Label = '波动' },
      @{ Name = 'model_note'; Label = '模型解释' }
    )

    Populate-TeamList
    $controls.FooterStatus.Text = "刷新完成: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  } catch {
    $controls.FooterStatus.Text = [string]$_
    [System.Windows.MessageBox]::Show([string]$_, 'LPL Dashboard Error', 'OK', 'Error') | Out-Null
  }
}

$controls.TeamList.Add_SelectionChanged({
  if ($controls.TeamList.SelectedItem -and $controls.TeamList.SelectedItem.Tag) {
    Show-Team $controls.TeamList.SelectedItem.Tag
  }
})
$controls.SearchBox.Add_TextChanged({ Populate-TeamList })
$controls.RefreshButton.Add_Click({ Refresh-Insights -RunMarkets:$false })
$controls.MarketsButton.Add_Click({ Refresh-Insights -RunMarkets:$true })
$controls.FolderButton.Add_Click({
  if (Test-Path -LiteralPath $AnalysisPath) {
    Start-Process explorer.exe -ArgumentList @($AnalysisPath)
  }
})

if ($UiSmokeTest) {
  Refresh-Insights -RunMarkets:$false
  Write-Output $controls.HeaderStatus.Text
  Write-Output $controls.LeagueSummary.Text
  exit 0
}

if ($UiShowSmokeTest) {
  $timer = New-Object Windows.Threading.DispatcherTimer
  $timer.Interval = [TimeSpan]::FromSeconds(1.5)
  $timer.Add_Tick({
    $timer.Stop()
    $window.Close()
  })
  $window.Add_ContentRendered({
    Refresh-Insights -RunMarkets:$false
    $timer.Start()
  })
} else {
  $window.Add_ContentRendered({ Refresh-Insights -RunMarkets:$false })
}

try {
  [void]$window.ShowDialog()
  if ($UiShowSmokeTest) {
    Write-Output 'ui_show_smoke_ok'
  }
} catch {
  Write-DashboardError $_
  Write-Error ([string]$_)
  exit 1
}
