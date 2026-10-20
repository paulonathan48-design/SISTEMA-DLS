$key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im10dHFzZmF3eG5yb3RhYmpmaXltIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4MjM4MzksImV4cCI6MjA5NzM5OTgzOX0.wTX_eOjPpSKLuez_JrBJ8K4oFRdTUxbLHICB65WJBLA'
$base = 'https://mttqsfawxnrotabjfiym.supabase.co/rest/v1/dls_demandas'
$headers = @{ apikey = $key; Authorization = "Bearer $key" }

Write-Output '--- demandas que possuem comentarios no banco ---'
$r = Invoke-RestMethod -Uri ($base + '?select=id,numero,status,comentarios&limit=300') -Headers $headers
$com = $r | Where-Object { $_.comentarios -and $_.comentarios.Count -gt 0 }
Write-Output ("   total com comentarios: " + $com.Count + " de " + $r.Count)
$com | Select-Object -First 3 | ForEach-Object {
  Write-Output ("   " + $_.numero + " -> " + ($_.comentarios | ConvertTo-Json -Compress -Depth 4))
}
