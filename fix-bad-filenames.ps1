$public = "C:\Users\User\Downloads\IGG-VIP-SERVER-STICKERS-UPDATED\Server\public\game-icons"
$map    = "C:\Users\User\Downloads\IGG-VIP-SERVER-STICKERS-UPDATED\Server\src\lib\game-icon-map.ts"

$remap = @{
  "Arcade_Fever_change_the_ball's_color_to_blue.png"       = "Arcade_Fever_change_the_balls_color_to_blue.png"
  "Arcade_Fever_change_the_ball's_color_to_purple.png"     = "Arcade_Fever_change_the_balls_color_to_purple.png"
  "Arcade_Fever_change_the_ball's_color_to_red.png"        = "Arcade_Fever_change_the_balls_color_to_red.png"
  "Arcade_Fever_change_the_ball's_color_to_yellow.png"     = "Arcade_Fever_change_the_balls_color_to_yellow.png"
  "Chef's_Hat.png"                                          = "Chefs_Hat.png"
  "Chef's_Hat_1.png"                                        = "Chefs_Hat_1.png"
  "Fisherman's_Hat.png"                                     = "Fishermans_Hat.png"
  "Fisherman's_Hat_1.png"                                   = "Fishermans_Hat_1.png"
  "His_Majesty's_Throne.png"                                = "His_Majestys_Throne.png"
  "His_Majesty's_Throne_1.png"                              = "His_Majestys_Throne_1.png"
  "Irish_Journey_Event_Rainbow's_End_Airport_Skin.png"     = "Irish_Journey_Event_Rainbows_End_Airport_Skin.png"
  "Pi#U251c#U2592ata.png"                                   = "Pi_U251c_U2592ata.png"
  "Rock_'n'_Roll_Festival_Event_Music_Express_Skin.png"    = "Rock_n_Roll_Festival_Event_Music_Express_Skin.png"
  "Rock_'n'_Roll_Festival_Event_Record_Station_Skin.png"   = "Rock_n_Roll_Festival_Event_Record_Station_Skin.png"
  "Santa's_Workshop_Fire_for_the_Fireplace.png"            = "Santas_Workshop_Fire_for_the_Fireplace.png"
  "Santa's_Workshop_Junk.png"                               = "Santas_Workshop_Junk.png"
  "Santa's_Workshop_Painting.png"                           = "Santas_Workshop_Painting.png"
  "Santa's_Workshop_Sack_of_Toys.png"                      = "Santas_Workshop_Sack_of_Toys.png"
  "Santa's_Workshop_Santa's_Suit.png"                       = "Santas_Workshop_Santas_Suit.png"
  "Santa's_Workshop_Wallpaper.png"                          = "Santas_Workshop_Wallpaper.png"
  "Santa's_Workshop_Wash_the_Cat.png"                       = "Santas_Workshop_Wash_the_Cat.png"
  "Santa's_Workshop_Yuletide_Express.png"                   = "Santas_Workshop_Yuletide_Express.png"
  "Santa's_Turbo_Sleigh.png"                                 = "Santas_Turbo_Sleigh.png"
  "Santa's_Turbo_Sleigh_1.png"                              = "Santas_Turbo_Sleigh_1.png"
  "Shepherd's_Horn-0.png"                                   = "Shepherds_Horn-0.png"
  "Sultan's_Palace.png"                                     = "Sultans_Palace.png"
  "Sun_Chairs_(red_&_blue).png"                             = "Sun_Chairs_red_and_blue.png"
  "Sun_Chairs_(red_&_blue)_1.png"                           = "Sun_Chairs_red_and_blue_1.png"
  "Ticket_Drucula's_Castle.png"                             = "Ticket_Draculas_Castle.png"
  "Time_0%-0.png"                                           = "Time_0_0.png"
  "Wanderers'_Harbor.png"                                    = "Wanderers_Harbor.png"
}

foreach ($old in $remap.Keys) {
  $new = $remap[$old]
  $oldPath = Join-Path $public $old
  $newPath = Join-Path $public $new
  if (Test-Path $oldPath) {
    Rename-Item -Path $oldPath -NewName $new -Force
    Write-Output "RENAMED  $old -> $new"
  }
}
if (Test-Path $map) {
  $txt = Get-Content $map -Raw
  $changed = $false
  foreach ($old in $remap.Keys) {
    $new = $remap[$old]
    $escaped = [regex]::Escape($old)
    if ($txt -match $escaped) {
      $txt = $txt -replace $escaped, $new
      $changed = $true
    }
  }
  Set-Content $map -Value $txt -NoNewline
  Write-Output "Updated $map references"
}
Write-Output "Done."
