param([string]$VoiceName = 'Microsoft Huihui Desktop')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$projectDirectory = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $projectDirectory 'apps\web\public\audio'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$manifestPath = Join-Path $projectDirectory 'apps/web/audio-source/neural-v1/voice-lines.json'
$lines = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $speaker.SelectVoice($VoiceName)
  $speaker.Rate = 0
  $speaker.Volume = 100
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  foreach ($line in $lines.PSObject.Properties) {
    $target = Join-Path $outputDirectory ($line.Name + '.wav')
    if (Test-Path -LiteralPath $target) { continue }
    $speaker.SetOutputToWaveFile($target, $format)
    $speaker.Speak([string]$line.Value)
    $speaker.SetOutputToNull()
  }
  Write-Output ('Generated ' + @($lines.PSObject.Properties).Count + ' voice clips.')
} finally {
  $speaker.Dispose()
}
