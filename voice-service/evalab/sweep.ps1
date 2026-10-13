# Runs the quick benchmark with several turn-taking settings and prints the numbers that matter.
#   .\evalab\sweep.ps1
# Each run starts its own gateway, so do not run other heavy work at the same time: it would
# change the latencies.
$configs = @(
  @{ name = 'A  onset 100 ms / barge 160 ms'; env = @{ VOICE_MIN_SPEECH_MS = '100'; VOICE_BARGE_IN_MIN_MS = '160' } },
  @{ name = 'B  onset  64 ms / barge  96 ms'; env = @{ VOICE_MIN_SPEECH_MS = '64';  VOICE_BARGE_IN_MIN_MS = '96' } },
  @{ name = 'C  onset  64 ms / barge 128 ms'; env = @{ VOICE_MIN_SPEECH_MS = '64';  VOICE_BARGE_IN_MIN_MS = '128' } }
)
$py = Join-Path $PSScriptRoot '..\.venv\Scripts\python.exe'
foreach ($c in $configs) {
  foreach ($k in $c.env.Keys) { Set-Item "env:$k" $c.env[$k] }
  Write-Host "=== $($c.name)"
  & $py -m evalab.turn_bench --quick 2>&1 | Out-Null
  $r = Get-Content (Join-Path $PSScriptRoot 'results\turn_bench-latest.json') | ConvertFrom-Json
  $fi = ($r.false_interruptions.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value.interrupted)/$($_.Value.trials)" }) -join '  '
  Write-Host ("  VAD onset p50/p95: {0}/{1} ms" -f $r.turns.vad_onset_ms.p50, $r.turns.vad_onset_ms.p95)
  Write-Host ("  speech end -> final p95: {0} ms ; -> first audio p50: {1} ms" -f $r.turns.speech_end_to_final_ms.p95, $r.turns.speech_end_to_first_audio_ms.p50)
  Write-Host ("  barge-in onset -> stop p50/p95: {0}/{1} ms ; missed: {2} ; stale frames: {3}" -f $r.barge_in.onset_to_stop_signal_ms.p50, $r.barge_in.onset_to_stop_signal_ms.p95, $r.barge_in.missed, $r.barge_in.stale_frames_after_interrupt_total)
  Write-Host "  false interruptions: $fi"
  foreach ($k in $c.env.Keys) { Remove-Item "env:$k" }
}
