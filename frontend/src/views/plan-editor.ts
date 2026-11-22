import {
  mdiAlert,
  mdiAlertCircle,
  mdiAspectRatio,
  mdiCheck,
  mdiContentCopy,
  mdiContentSave,
  mdiCursorDefault,
  mdiDelete,
  mdiDoor,
  mdiDotsVertical,
  mdiDragVertical,
  mdiExport,
  mdiFileUpload,
  mdiImage,
  mdiImport,
  mdiInformation,
  mdiLightbulb,
  mdiMagnet,
  mdiPin,
  mdiPinOff,
  mdiRedo,
  mdiRefresh,
  mdiRestore,
  mdiRobotVacuum,
  mdiUndo,
  mdiVectorPolygon,
  mdiVectorSquare,
  mdiVectorUnion,
} from "@mdi/js";
import { css, html, nothing, type PropertyValues } from "lit";
import { deflate, fits, fromBase64, INLINE_MAX, MESSAGE_MAX, megabytes, toBase64, utf8Length } from "../api/deflate";
import type {
  BackgroundImage,
  BackgroundUpload,
  BulbHeight,
  DoorKind,
  Plan,
  PlanImportResponse,
  PlanWarning,
  Point,
  ValetudoRobotsResponse,
  WallKind,
} from "../api/types";
import { Backdrop, imageUrl } from "../background";
import { History } from "../editor/undo";
import { draftKey, dropDraft, getImage, keepAlive, listDrafts, putImage, saveDraft, sweepImages, type Draft } from "../editor/drafts";
import {
  addDoor,
  edgeLengths,
  importPlan,
  doorSelection,
  cutCorner,
  mergedArea,
  mergeRooms,
  mergeSides,
  mergeTrouble,
  movedBulbs,
  unpinnedBulbs,
  lostDoors,
  looksRetired,
  nudge,
  nudgeSelection,
  placeBulb,
  resizeRoom,
  remove,
  removeBulb,
  removeDoor,
  removeRoom,
  sameContent,
  samePlan,
  retiredOver,
  retireGone,
  reviveRetired,
  type Renamed,
  setEdgeLength,
  setWallKind,
  trackSelection,
  updateBulb,
  updateDoor,
  updateRoom,
  vertexSelection,
  wallIndex,
  wallSelection,
  type Selection,
} from "../editor/ops";
import { type OutglowEditorCanvas, type Tool } from "../editor/editor-canvas";
import "../editor/editor-canvas";
import { fmtDateTime, fmtNumber } from "../format";
import { add, area, boxOf, bulbRoom, dist, pairKey, roomAt, validate, wallPairs, type Box, type Issue } from "../geometry";
import { strings } from "../i18n";
import { icon } from "../icons";
import { errorCode } from "../strings/common";
import { tc } from "../strings/common";
import { ROOM_PALETTE, shared, tokens } from "../theme";
import { ViewBase } from "./base";

export const te = strings(
  {
    title: "Floor plan",
    tool_select: "Select",
    tool_rect: "Rectangle",
    tool_poly: "Polygon",
    tool_door: "Door",
    tool_bulb: "Bulb",
    undo: "Undo",
    redo: "Redo",
    grid: "Grid",
    grid_value: "{n} cm",
    magnet: "Snap to walls and corners",
    keep_ratio: "Keep proportions when resizing",
    background_layer: "Background",
    import: "Import",
    export: "Export",
    export_title: "Download the plan as Outglow JSON",
    more: "More",
    exported: "Plan downloaded as {file}.",
    export_sheet: "Plan as Outglow JSON",
    export_copy_hint: "This app cannot save files. Copy the plan and keep it as {file}.",
    copy: "Copy",
    copied: "Plan copied.",
    save: "Save",
    saved: "Saved",
    unsaved: "Unsaved changes",
    shortcut: "{label} ({key})",
    hint_select: "Click a room to resize, move or reshape it, or a wall, door or bulb to edit it. Drag empty space to pan.",
    hint_room:
      "Square handles resize (Shift keeps proportions, Alt from the centre); drag a wall to move it, shared walls move in both rooms (Alt: only this one); drag inside to move the room (Shift: in a straight line); drag a corner to reshape, double-click a wall to add one; click a corner and press Delete, or double-click it, to remove it. Cmd/Ctrl turns snapping off. Arrows move, Alt+arrows resize; , and . pick a corner, [ and ] a wall.",
    hint_room_touch: "Drag the square handles to resize, a wall to move it, the inside to move the room and a corner to reshape; tap a corner to remove it from the panel. The proportions button in the toolbar keeps the shape.",
    hint_wall: "Drag the wall to move it; arrow keys move it too. Delete turns it into No wall, the rooms stay apart; Merge into one room in the panel takes the line away. Double-click a room's edge to add a corner. [ and ] pick the previous and next wall.",
    hint_vertex: "Drag the corner to move it; arrow keys move it too. Delete, Backspace or a double-click removes it. , and . pick the previous and next corner.",
    hint_vertex_touch: "Drag the corner to move it. Remove corner in the panel takes it away.",
    corner: "Corner",
    corner_of: "Corner {n} of {room}",
    corner_at: "At {x} m, {y} m",
    remove_corner: "Remove corner",
    corner_missing: "This corner is no longer there.",
    corner_min: "A room needs at least 3 corners.",
    corner_overlap: "This corner stays: without it the room would run over another room.",
    corner_shape: "This corner stays: without it the room's outline would cross itself or fold flat.",
    corner_picked: "Corner {n} of {room}, at {x} m, {y} m",
    wall_picked: "Wall {k} of {n} of {room}: between {a} and {b}, {length} m",
    wall_delete: "Delete: No wall here, the rooms stay apart.",
    merge_rooms: "Merge into one room",
    merge_failed: "These rooms cannot be merged: together they would not make one room without a hole.",
    merge_inside: "These rooms cannot be merged: {inner} lies inside {outer}. Move {inner} so the two only meet at the wall.",
    merge_overlap: "These rooms cannot be merged: they overlap. Move a wall so the two only meet at the wall.",
    rooms_merged: "{gone} is now part of {keep}.",
    merge_loses: "Merging removes {gone}: when you save, its settings, its entities in Home Assistant and what Outglow learnt for it go.",
    merge_area_drops: "{keep} stays in the area {area}; the area {gone_area} of {gone} is then no room's.",
    merge_area_takes: "{keep} takes the area {area} from {gone}.",
    merge_area_bulbs: {
      one: "{bulbs} is not on the plan and belongs to {gone} through the area {gone_area}: after the merge it belongs to no room. Put it on the plan, or move it to the area {area} in Home Assistant.",
      other: "{bulbs} are not on the plan and belong to {gone} through the area {gone_area}: after the merge they belong to no room. Put them on the plan, or move them to the area {area} in Home Assistant.",
    },
    wall_mixed: "The wall between {a} and {b} had more than one type and is now {kind} along its whole length.",
    bulb_moved: "After this change {bulb} belongs to {to} (before: {from}). To keep it in {from}, choose that room under Room in the bulb's settings.",
    bulb_moved_many: "After this change {bulbs} belong to other rooms. To keep one where it was, choose its room under Room in the bulb's settings.",
    outside: "no room",
    door_lost: "The door between {a} and {b} goes, as the rooms no longer share a wall.",
    door_squeezed: "One of the doors between {a} and {b} goes, as the wall they share is too short for both.",
    bulb_unpinned: "{bulb} is no longer pinned to {from}, as you moved it into {to}.",
    hint_rect: "Drag to draw a room. Corners snap to the grid and to other rooms; hold Alt or Cmd/Ctrl to draw freely.",
    hint_poly: "Click to add corners, then click the first corner or press Enter to close. Backspace removes the last corner, Esc cancels.",
    hint_door: "Click a shared wall between two rooms to put a door there.",
    hint_bulb: "Click on the plan to place {name}.",
    hint_bulb_none: "All bulbs are on the plan. Drag a bulb to move it.",
    narrow: "Drawing rooms works best on a computer. Here you can move bulbs and fix details.",
    dismiss: "Got it",
    plan_card: "Rooms",
    no_selection: "Select something on the plan to edit it.",
    room: "Room",
    name: "Name",
    area: "Home Assistant area",
    area_none: "None",
    colour: "Colour",
    entrance: "Front door opens into this room",
    size: "{area} m² · perimeter {perimeter} m",
    walls_of_room: "Edges",
    edge: "Edge {n}",
    delete_room: "Delete room",
    wall: "Wall",
    wall_between: "Between {a} and {b}",
    wall_length: "Length {n} m",
    wall_kind: "Wall type",
    kind_partition: "Partition",
    kind_brick: "Brick",
    kind_concrete: "Concrete",
    kind_glass: "Glass",
    kind_none: "No wall",
    add_door: "Add a door here",
    door: "Door",
    door_kind: "Type",
    kind_door: "Door",
    kind_opening: "Opening",
    width: "Width (m)",
    position: "Position along the wall",
    delete_door: "Delete door",
    bulb: "Bulb",
    height: "Mounted",
    height_ceiling: "Ceiling",
    height_pendant: "Pendant",
    height_lamp: "Lamp",
    bulb_room: "Room",
    bulb_room_auto: "From position ({room})",
    bulb_room_auto_none: "From position (none)",
    position_xy: "x {x} m · y {y} m",
    remove_bulb: "Remove from plan",
    unplaced: "Not on the plan",
    unplaced_hint: "Drag a bulb onto the plan, or tap it and then tap the plan.",
    unplaced_none: "Every bulb is on the plan.",
    offline: "offline",
    issues: "Checks",
    issues_none: "No problems found.",
    issue_bulb_outside_rooms: "{bulb} is outside every room",
    issue_room_without_bulb: "{room} has no bulb; it is seen only through walls",
    issue_overlapping_rooms: "{room} overlaps {other}",
    issue_self_intersecting: "{room}: edges cross each other",
    issue_too_few_points: "{room}: needs at least three corners",
    issue_unknown_room: "{bulb} is assigned to a room that does not exist",
    issue_bulb_pinned_elsewhere: "{bulb} is pinned to {room}, though it stands in {other}",
    unpin: "Unpin",
    pinned_to: "Pinned to {room}: moving walls does not change its room.",
    issue_no_rooms: "Draw your first room with Rectangle (R) or Polygon (P).",
    issue_no_bulbs: "Drag your bulbs onto the plan.",
    import_title: "Import a plan",
    choose_file: "Choose a file",
    paste: "…or paste the contents here: an Outglow plan or a Valetudo map (JSON)",
    fetch_vacuum: "Fetch from the vacuum",
    fetching: "Fetching…",
    fetch_from: "Fetch from {name}",
    robot_address: "Robot address",
    robot_hint: "Valetudo robots found through MQTT need no address. Otherwise enter the robot's address, for example http://192.168.1.50; it is remembered.",
    fetch: "Fetch",
    fetch_not_found: "The robot has not published its map over MQTT. Enter its address instead.",
    fetch_failed: "Could not get the map from the robot: {message}",
    too_large: "This is {size} MB even compressed, and Home Assistant takes at most {limit} MB at once. Fetch the map from the vacuum instead.",
    keep_bulbs: "Keep the bulbs placed on the current plan",
    keep_bulbs_plan: "An Outglow plan is used as it is, with its own bulbs",
    source_outglow_plan: "Recognised: an Outglow plan",
    source_prototype_layout: "Recognised: a layout of the earlier prototype",
    source_prototype_yaml: "Recognised: a plan of the earlier prototype (YAML)",
    source_valetudo_map: "Recognised: a Valetudo vacuum map",
    kept_aligned: "{bulbs} bulbs kept and moved onto the map by {rooms} rooms with the same name (turned {rotation}°{mirrored}, rooms off by {rms} m)",
    kept_mirrored: ", mirrored",
    kept_unaligned: "{bulbs} bulbs kept where they were; no room has the same name",
    kept_one_room: "{bulbs} bulbs kept where they were; only one room has the same name, and moving them takes three",
    kept_two_rooms: "{bulbs} bulbs kept where they were; only two rooms have the same name, too few to tell how the map is turned, and moving them takes three",
    background_lost: "The background of this version is no longer stored; import the map again to bring it back",
    background_too_large: "The background is {size} MB even compressed, and Home Assistant takes at most {limit} MB at once",
    preview: "Preview",
    previewing: "Reading…",
    use_plan: "Use this plan",
    import_summary: "{rooms} rooms · {bulbs} bulbs · {doors} doors",
    import_replace: "This replaces the plan in the editor. You can undo it, and nothing is stored until you save.",
    warning_unknown_bulb: "Bulb {ieee} is not known to Zigbee2MQTT",
    warning_bulb_outside_rooms: "Bulb {ieee} is outside every room",
    warning_room_without_bulb: "Room {room} has no bulb",
    warning_overlapping_rooms: "Rooms overlap: {details}",
    warning_dropped_field: "Ignored field {field}",
    warning_unknown_room: "Unknown room {room}",
    warning_dropped_segment: "Skipped map segment {segment}: only {area_m2} m²",
    warning_no_segments: "The map has no rooms yet. Split it into rooms in Valetudo first.",
    warning_no_doors: "No doorways found between the rooms; draw the doors yourself",
    warning_bulbs_not_aligned: "The bulbs could not be moved onto the map; check where they are",
    warning_bulb_pinned_elsewhere: "Bulb {ieee} is pinned to {room}, though it stands in {at}",
    warning_room_simplified: "Room {room} had too many corners; drawn with {vertices} corners, up to {tolerance_m} m off",
    warning_background_dropped: "The map is too detailed for a background (over {limit_mb} MB); it is left out",
    imported: "Plan imported. Review it and save.",
    conflict: "Someone saved the plan in another window while you were editing.",
    conflict_remote: "The connection came back and the plan on the server has changed meanwhile. Your unsaved changes are kept.",
    reconnected_kept: "The connection came back. Your unsaved changes are kept.",
    save_landed: "The connection came back; the plan had been saved.",
    draft_found: "Unsaved changes to the plan from {when} were found in this browser.",
    draft_stale: "The plan on the server has changed since; saving the restored plan replaces it.",
    draft_restore: "Restore",
    draft_discard: "Discard",
    draft_restored: "Unsaved changes restored. Review them and save.",
    draft_background_lost: "The background from the import could not be kept in the browser; import the map again to get it back.",
    draft_restored_lost: "Unsaved changes restored without the imported background. Import the map again to get it back.",
    reload: "Load theirs",
    overwrite: "Keep mine",
    no_bulb_to_place: "Pick a bulb from the list first.",
    renamed_rooms: "{rooms}: a room with this id was removed and saved, so it comes back as a new room. Home Assistant gives it new entities (new entity_id); update automations that used the old ones.",
    conflict_removes: "Keep mine removes: {rooms}.",
    conflict_renames: "Keep mine gives new ids and new entities (new entity_id) to: {rooms}.",
    conflict_same: "Keep mine changes no room ids.",
    new_entities: "A saved plan had a room with this name and it was removed. For Home Assistant this is a new room: its entities get new IDs ({entity}), so automations that used the old room need updating.",
    save_invalid: "The plan was not saved: {message}",
    edit_selection: "Edit",
    rooms_count: { one: "{n} room", other: "{n} rooms" },
    bulbs_count: { one: "{n} bulb", other: "{n} bulbs" },
  },
  {
    title: "Plan mieszkania",
    tool_select: "Zaznacz",
    tool_rect: "Prostokąt",
    tool_poly: "Wielokąt",
    tool_door: "Drzwi",
    tool_bulb: "Żarówka",
    undo: "Cofnij",
    redo: "Ponów",
    grid: "Siatka",
    grid_value: "{n} cm",
    magnet: "Przyciągaj do ścian i narożników",
    keep_ratio: "Zachowuj proporcje przy zmianie rozmiaru",
    background_layer: "Tło",
    export: "Eksportuj",
    export_title: "Pobierz plan jako Outglow JSON",
    more: "Więcej",
    exported: "Plan pobrany jako {file}.",
    export_sheet: "Plan jako Outglow JSON",
    export_copy_hint: "Ta aplikacja nie zapisuje plików. Skopiuj plan i zachowaj go jako {file}.",
    copy: "Kopiuj",
    copied: "Plan skopiowany.",
    import: "Import",
    save: "Zapisz",
    saved: "Zapisano",
    unsaved: "Niezapisane zmiany",
    shortcut: "{label} ({key})",
    hint_select: "Kliknij pokój, żeby zmienić jego rozmiar, położenie albo kształt, albo ścianę, drzwi czy żarówkę, żeby je edytować. Przeciągnij puste miejsce, żeby przesunąć widok.",
    hint_room:
      "Kwadratowe uchwyty zmieniają rozmiar (Shift zachowuje proporcje, Alt od środka); przeciągnięta ściana przesuwa się, wspólna w obu pokojach (Alt: tylko w tym); przeciągnięte wnętrze przesuwa pokój (Shift: w linii prostej); narożnik zmienia kształt, dwuklik na ścianie dodaje narożnik; kliknięty narożnik usuwa Delete albo dwuklik. Cmd/Ctrl wyłącza przyciąganie. Strzałki przesuwają, Alt+strzałki zmieniają rozmiar; , i . wybierają narożnik, [ i ] ścianę.",
    hint_room_touch: "Przeciągnij kwadratowe uchwyty, żeby zmienić rozmiar, ścianę, żeby ją przesunąć, wnętrze, żeby przesunąć pokój, a narożnik, żeby zmienić kształt; stuknięty narożnik usuniesz w panelu. Przycisk proporcji w pasku zachowuje kształt.",
    hint_wall: "Przeciągnij ścianę, żeby ją przesunąć; strzałki też ją przesuwają. Delete zamienia ją w „Bez ściany”, pokoje zostają osobno; Scal w jeden pokój w panelu usuwa tę linię. Dwuklik na krawędzi pokoju dodaje narożnik. [ i ] wybierają poprzednią i następną ścianę.",
    hint_vertex: "Przeciągnij narożnik, żeby go przesunąć; strzałki też go przesuwają. Delete, Backspace albo dwuklik go usuwa. , i . wybierają poprzedni i następny narożnik.",
    hint_vertex_touch: "Przeciągnij narożnik, żeby go przesunąć. Usuń narożnik w panelu go usuwa.",
    corner: "Narożnik",
    corner_of: "Narożnik {n} pokoju {room}",
    corner_at: "Położenie: {x} m, {y} m",
    remove_corner: "Usuń narożnik",
    corner_missing: "Tego narożnika już nie ma.",
    corner_min: "Pokój musi mieć co najmniej 3 narożniki.",
    corner_overlap: "Ten narożnik zostaje: bez niego pokój wszedłby na inny pokój.",
    corner_shape: "Ten narożnik zostaje: bez niego obrys pokoju przeciąłby sam siebie albo się spłaszczył.",
    corner_picked: "Narożnik {n} pokoju {room}, położenie {x} m, {y} m",
    wall_picked: "Ściana {k} z {n} pokoju {room}: między {a} i {b}, {length} m",
    wall_delete: "Delete: bez ściany, pokoje zostają osobno.",
    merge_rooms: "Scal w jeden pokój",
    merge_failed: "Tych pokojów nie da się scalić: razem nie tworzą jednego pokoju bez dziury.",
    merge_inside: "Tych pokojów nie da się scalić: {inner} leży wewnątrz pokoju {outer}. Przesuń {inner} tak, żeby pokoje stykały się tylko ścianą.",
    merge_overlap: "Tych pokojów nie da się scalić: nachodzą na siebie. Przesuń ścianę tak, żeby pokoje stykały się tylko ścianą.",
    rooms_merged: "{gone} jest teraz częścią pokoju {keep}.",
    merge_loses: "Scalenie usuwa pokój {gone}: po zapisaniu przepadną jego ustawienia, encje w Home Assistant i to, czego Outglow się dla niego nauczył.",
    merge_area_drops: "{keep} zostaje w obszarze {area}; obszar {gone_area} pokoju {gone} nie będzie już należał do żadnego pokoju.",
    merge_area_takes: "{keep} przejmuje obszar {area} od pokoju {gone}.",
    merge_area_bulbs: {
      one: "Żarówki {bulbs} nie ma na planie, a do pokoju {gone} należy przez obszar {gone_area}: po scaleniu nie będzie należeć do żadnego pokoju. Postaw ją na planie albo przenieś ją w Home Assistant do obszaru {area}.",
      other: "Żarówek {bulbs} nie ma na planie, a do pokoju {gone} należą przez obszar {gone_area}: po scaleniu nie będą należeć do żadnego pokoju. Postaw je na planie albo przenieś je w Home Assistant do obszaru {area}.",
    },
    wall_mixed: "Ściana między: {a} i {b} miała kilka rodzajów, teraz na całej długości: {kind}.",
    bulb_moved: "Po tej zmianie {bulb} należy do: {to} (wcześniej: {from}). Żeby została w: {from}, wybierz ten pokój w polu Pokój żarówki.",
    bulb_moved_many: "Po tej zmianie {bulbs} należą do innych pokojów. Żeby któraś została, wybierz jej pokój w polu Pokój żarówki.",
    outside: "żaden pokój",
    door_lost: "Drzwi między pokojami {a} i {b} znikają, bo pokoje nie mają już wspólnej ściany.",
    door_squeezed: "Jedne z drzwi między pokojami {a} i {b} znikają, bo wspólna ściana jest za krótka dla obu.",
    bulb_unpinned: "{bulb} nie jest już przypięta do pokoju {from}, bo przeniesiono ją do: {to}.",
    hint_rect: "Przeciągnij, żeby narysować pokój. Narożniki przyciągają się do siatki i innych pokojów; z Alt albo Cmd/Ctrl rysujesz swobodnie.",
    hint_poly: "Klikaj, żeby dodać narożniki; zamknij klikając pierwszy albo Enterem. Backspace usuwa ostatni, Esc anuluje.",
    hint_door: "Kliknij wspólną ścianę dwóch pokojów, żeby wstawić drzwi.",
    hint_bulb: "Kliknij na planie, żeby postawić: {name}.",
    hint_bulb_none: "Wszystkie żarówki są na planie. Przeciągnij żarówkę, żeby ją przesunąć.",
    narrow: "Rysowanie pokojów najlepiej idzie na komputerze. Tutaj przesuniesz żarówki i poprawisz szczegóły.",
    dismiss: "Rozumiem",
    plan_card: "Pokoje",
    no_selection: "Zaznacz coś na planie, żeby to edytować.",
    room: "Pokój",
    name: "Nazwa",
    area: "Obszar w Home Assistant",
    area_none: "Brak",
    colour: "Kolor",
    entrance: "Drzwi wejściowe do mieszkania prowadzą tutaj",
    size: "{area} m² · obwód {perimeter} m",
    walls_of_room: "Krawędzie",
    edge: "Krawędź {n}",
    delete_room: "Usuń pokój",
    wall: "Ściana",
    wall_between: "Między: {a} i {b}",
    wall_length: "Długość {n} m",
    wall_kind: "Rodzaj ściany",
    kind_partition: "Działowa",
    kind_brick: "Cegła",
    kind_concrete: "Beton",
    kind_glass: "Szkło",
    kind_none: "Bez ściany",
    add_door: "Dodaj tu drzwi",
    door: "Drzwi",
    door_kind: "Rodzaj",
    kind_door: "Drzwi",
    kind_opening: "Przejście",
    width: "Szerokość (m)",
    position: "Położenie na ścianie",
    delete_door: "Usuń drzwi",
    bulb: "Żarówka",
    height: "Montaż",
    height_ceiling: "Sufit",
    height_pendant: "Zwis",
    height_lamp: "Lampa",
    bulb_room: "Pokój",
    bulb_room_auto: "Z położenia ({room})",
    bulb_room_auto_none: "Z położenia (brak)",
    position_xy: "x {x} m · y {y} m",
    remove_bulb: "Usuń z planu",
    unplaced: "Nieumieszczone",
    unplaced_hint: "Przeciągnij żarówkę na plan albo stuknij ją, a potem miejsce na planie.",
    unplaced_none: "Wszystkie żarówki są na planie.",
    offline: "offline",
    issues: "Sprawdzenie",
    issues_none: "Nie znaleziono problemów.",
    issue_bulb_outside_rooms: "{bulb} stoi poza pokojami",
    issue_room_without_bulb: "{room} nie ma żarówki; widać go tylko przez ściany",
    issue_overlapping_rooms: "{room} nachodzi na {other}",
    issue_self_intersecting: "{room}: krawędzie się przecinają",
    issue_too_few_points: "{room}: potrzeba co najmniej trzech narożników",
    issue_unknown_room: "{bulb} jest przypisana do nieistniejącego pokoju",
    issue_bulb_pinned_elsewhere: "{bulb} jest przypięta do pokoju {room}, choć stoi w: {other}",
    unpin: "Odepnij",
    pinned_to: "Przypięta do pokoju {room}: przesuwanie ścian nie zmienia jej pokoju.",
    issue_no_rooms: "Narysuj pierwszy pokój: Prostokąt (R) albo Wielokąt (P).",
    issue_no_bulbs: "Przeciągnij żarówki na plan.",
    import_title: "Import planu",
    choose_file: "Wybierz plik",
    paste: "…albo wklej tu zawartość: plan Outglow albo mapę Valetudo (JSON)",
    fetch_vacuum: "Pobierz z odkurzacza",
    fetching: "Pobieram…",
    fetch_from: "Pobierz z: {name}",
    robot_address: "Adres robota",
    robot_hint: "Roboty Valetudo widoczne przez MQTT nie potrzebują adresu. W innym razie wpisz adres robota, np. http://192.168.1.50; zostanie zapamiętany.",
    fetch: "Pobierz",
    fetch_not_found: "Robot nie opublikował mapy przez MQTT. Wpisz jego adres.",
    fetch_failed: "Nie udało się pobrać mapy z robota: {message}",
    too_large: "To {size} MB nawet po skompresowaniu, a Home Assistant przyjmuje naraz najwyżej {limit} MB. Pobierz mapę z odkurzacza.",
    keep_bulbs: "Zachowaj żarówki ustawione na obecnym planie",
    keep_bulbs_plan: "Plan Outglow jest brany w całości, z jego żarówkami",
    source_outglow_plan: "Rozpoznano: plan Outglow",
    source_prototype_layout: "Rozpoznano: układ z wcześniejszego prototypu",
    source_prototype_yaml: "Rozpoznano: plan z wcześniejszego prototypu (YAML)",
    source_valetudo_map: "Rozpoznano: mapa z odkurzacza Valetudo",
    kept_aligned: "Żarówki zachowane ({bulbs}) i przeniesione na mapę według pokojów o tych samych nazwach ({rooms}); obrót {rotation}°{mirrored}, rozbieżność pokojów {rms} m",
    kept_mirrored: ", odbicie",
    kept_unaligned: "Żarówki zachowane ({bulbs}) w dotychczasowych miejscach; żaden pokój nie ma tej samej nazwy",
    kept_one_room: "Żarówki zachowane ({bulbs}) w dotychczasowych miejscach; tylko jeden pokój ma tę samą nazwę, a do przeniesienia trzeba trzech",
    kept_two_rooms: "Żarówki zachowane ({bulbs}) w dotychczasowych miejscach; tylko dwa pokoje mają te same nazwy, za mało, by poznać obrót mapy, a do przeniesienia trzeba trzech",
    background_lost: "Tło tej wersji nie jest już zapisane; zaimportuj mapę jeszcze raz, żeby je przywrócić",
    background_too_large: "Tło ma {size} MB nawet po skompresowaniu, a Home Assistant przyjmuje naraz najwyżej {limit} MB",
    preview: "Podgląd",
    previewing: "Czytam…",
    use_plan: "Użyj tego planu",
    import_summary: "pokoje: {rooms} · żarówki: {bulbs} · drzwi: {doors}",
    import_replace: "To zastąpi plan w edytorze. Można to cofnąć, a nic nie zapisze się bez „Zapisz”.",
    warning_unknown_bulb: "Żarówki {ieee} nie ma w Zigbee2MQTT",
    warning_bulb_outside_rooms: "Żarówka {ieee} stoi poza pokojami",
    warning_room_without_bulb: "Pokój {room} nie ma żarówki",
    warning_overlapping_rooms: "Pokoje nachodzą na siebie: {details}",
    warning_dropped_field: "Pominięto pole {field}",
    warning_unknown_room: "Nieznany pokój {room}",
    warning_dropped_segment: "Pominięto fragment mapy {segment}: tylko {area_m2} m²",
    warning_no_segments: "Mapa nie ma jeszcze pokojów. Najpierw podziel ją na pokoje w Valetudo.",
    warning_no_doors: "Nie znaleziono przejść między pokojami; dorysuj drzwi",
    warning_bulbs_not_aligned: "Nie udało się przenieść żarówek na mapę; sprawdź, gdzie stoją",
    warning_bulb_pinned_elsewhere: "Żarówka {ieee} jest przypięta do pokoju {room}, choć stoi w: {at}",
    warning_room_simplified: "Pokój {room} miał za dużo narożników; narysowany z {vertices} narożnikami, z odchyłką do {tolerance_m} m",
    warning_background_dropped: "Mapa jest zbyt szczegółowa na tło (ponad {limit_mb} MB); pominięto je",
    imported: "Plan wczytany. Przejrzyj go i zapisz.",
    conflict: "Ktoś zapisał plan w innym oknie, kiedy go edytowałeś.",
    conflict_remote: "Połączenie wróciło, a plan na serwerze w tym czasie się zmienił. Twoje niezapisane zmiany są zachowane.",
    reconnected_kept: "Połączenie wróciło. Twoje niezapisane zmiany są zachowane.",
    save_landed: "Połączenie wróciło; plan został zapisany.",
    draft_found: "W tej przeglądarce są niezapisane zmiany planu z {when}.",
    draft_stale: "Plan na serwerze od tego czasu się zmienił; zapisanie przywróconego planu go zastąpi.",
    draft_restore: "Przywróć",
    draft_discard: "Odrzuć",
    draft_restored: "Przywrócono niezapisane zmiany. Przejrzyj je i zapisz.",
    draft_background_lost: "Tła z importu nie udało się zachować w przeglądarce; zaimportuj mapę ponownie, żeby je odzyskać.",
    draft_restored_lost: "Przywrócono niezapisane zmiany bez tła z importu. Zaimportuj mapę ponownie, żeby je odzyskać.",
    reload: "Wczytaj tamten",
    overwrite: "Zostaw mój",
    no_bulb_to_place: "Najpierw wybierz żarówkę z listy.",
    renamed_rooms: "{rooms}: pokój o tym id usunięto i zapisano, więc wraca jako nowy pokój. Home Assistant da mu nowe encje (nowe entity_id); popraw automatyzacje, które używały starych.",
    conflict_removes: "„Zostaw mój” usunie: {rooms}.",
    conflict_renames: "„Zostaw mój” da nowe id i nowe encje (nowe entity_id) pokojom: {rooms}.",
    conflict_same: "„Zostaw mój” nie zmieni id żadnego pokoju.",
    new_entities: "Zapisany plan miał pokój o tej nazwie i został on usunięty. Dla Home Assistant to nowy pokój: jego encje dostaną nowe identyfikatory ({entity}), więc automatyzacje, które używały starego pokoju, trzeba poprawić.",
    save_invalid: "Nie zapisano planu: {message}",
    edit_selection: "Edytuj",
    rooms_count: { one: "{n} pokój", few: "{n} pokoje", many: "{n} pokojów", other: "{n} pokoju" },
    bulbs_count: { one: "{n} żarówka", few: "{n} żarówki", many: "{n} żarówek", other: "{n} żarówki" },
  },
);

const TOOLS: { id: Tool; icon: string; key: string }[] = [
  { id: "select", icon: mdiCursorDefault, key: "V" },
  { id: "rect", icon: mdiVectorSquare, key: "R" },
  { id: "poly", icon: mdiVectorPolygon, key: "P" },
  { id: "door", icon: mdiDoor, key: "D" },
  { id: "bulb", icon: mdiLightbulb, key: "B" },
];

const GRIDS = [0.05, 0.1, 0.25];
const WALL_KINDS: WallKind[] = ["partition", "brick", "concrete", "glass", "none"];
const HEIGHTS: BulbHeight[] = ["ceiling", "pendant", "lamp"];
const KEPT_BACKGROUNDS = 3;
const BACKGROUND_KEY = "outglow.editor.background";
const SHORTCUTS: Record<string, Tool> = { v: "select", r: "rect", p: "poly", d: "door", b: "bulb" };
const RESIZE_KEYS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
type PickKey = ["corner" | "wall", 1 | -1];
const PICK_KEYS: Record<string, PickKey> = { ",": ["corner", -1], ".": ["corner", 1], "[": ["wall", -1], "]": ["wall", 1] };
const PICK_CODES: Record<string, PickKey> = { Comma: ["corner", -1], Period: ["corner", 1], BracketLeft: ["wall", -1], BracketRight: ["wall", 1] };
const OWN_KEYS = new Set(["Escape", "Enter", "Backspace", "Delete", "+", "=", "-", ...Object.keys(RESIZE_KEYS)]);

function pickKey(event: KeyboardEvent): PickKey | null {
  const free = !event.ctrlKey && !event.metaKey;
  if (!free && !event.getModifierState("AltGraph")) return null;
  const own = event.key.toLowerCase() in SHORTCUTS || OWN_KEYS.has(event.key);
  return PICK_KEYS[event.key] ?? (own ? null : (PICK_CODES[event.code] ?? null));
}

export function exportName(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `outglow-plan-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

function bridged(w: Window): boolean {
  try {
    const host = w as unknown as { externalApp?: unknown; webkit?: { messageHandlers?: { getExternalAuth?: unknown } } };
    return Boolean(host.externalApp ?? host.webkit?.messageHandlers?.getExternalAuth);
  } catch {
    return false;
  }
}

function inApp(): boolean {
  return bridged(window) || (window.parent !== window && bridged(window.parent));
}

export function exportText(plan: Plan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function warningText(loc: Parameters<typeof te>[0], warning: PlanWarning): string {
  const params = Object.fromEntries(Object.entries(warning.params).map(([k, v]) => [k, v === null ? "—" : typeof v === "number" ? v : String(v)]));
  const details = Object.values(params).join(", ");
  const text = te(loc, `warning_${warning.code}`, { ...params, details });
  return text.replace(/\{\w+\}/g, details || "?");
}

function wallEnds(plan: Plan, wall: number): [string, string] | undefined {
  const order = (id: string): number => plan.rooms.findIndex((r) => r.id === id);
  const ends = wallPairs(plan)[wall]?.split("|") as [string, string] | undefined;
  return ends && (order(ends[0]) <= order(ends[1]) ? ends : [ends[1], ends[0]]);
}

function seriesId(selection: NonNullable<Selection>): string {
  if (selection.kind === "wall") return `wall:${selection.pair}`;
  if (selection.kind === "door") return `door:${selection.pair}:${selection.index}`;
  if (selection.kind === "vertex") return `vertex:${selection.id}:${selection.index}`;
  return selection.kind === "room" ? `room:${selection.id}` : `bulb:${selection.ieee}`;
}

interface KeyRun {
  family: string;
  key: string;
  base: Plan;
  selection: Selection;
  total: Point;
  after: Selection;
}

interface ListDrag {
  ieee: string;
  pointer: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
  moved: boolean;
  point: Point | null;
}

export class OutglowPlanEditor extends ViewBase {
  static override properties = {
    ...ViewBase.properties,
    _version: { state: true },
    _preview: { state: true },
    _selection: { state: true },
    _tool: { state: true },
    _grid: { state: true },
    _magnet: { state: true },
    _keepRatio: { state: true },
    _saving: { state: true },
    _conflict: { state: true },
    _importOpen: { state: true },
    _importKeep: { state: true },
    _robots: { state: true },
    _robotUrl: { state: true },
    _importText: { state: true },
    _importResult: { state: true },
    _importError: { state: true },
    _importBusy: { state: true },
    _listDrag: { state: true },
    _armed: { state: true },
    _narrowDismissed: { state: true },
    _notice: { state: true },
    _speak: { state: true },
    _menuOpen: { state: true },
    _exportCopy: { state: true },
    _renamedNotice: { state: true },
    _keepMine: { state: true },
    reserved: { attribute: false },
    _showBackground: { state: true },
    _drafts: { state: true },
  };

  declare _version: number;
  declare _preview: Plan | null;
  declare _selection: Selection;
  declare _tool: Tool;
  declare _grid: number;
  declare _magnet: boolean;
  declare _keepRatio: boolean;
  declare _saving: boolean;
  declare _conflict: "save" | "remote" | null;
  declare _importOpen: boolean;
  declare _importKeep: boolean;
  declare _robots: ValetudoRobotsResponse | null;
  declare _robotUrl: string;
  declare _importText: string;
  declare _importResult: PlanImportResponse | null;
  declare _importError: string | null;
  declare _importBusy: boolean;
  declare _listDrag: ListDrag | null;
  declare _armed: string | null;
  declare _narrowDismissed: boolean;
  declare _notice: string | null;
  declare _speak: boolean;
  declare _menuOpen: boolean;
  declare _exportCopy: { name: string; text: string } | null;
  declare _renamedNotice: Renamed[];
  declare _keepMine: { removes: string[]; renames: string[] } | null;
  declare reserved: string[];
  declare _showBackground: boolean;
  declare _drafts: Draft[];

  private _history: History<Plan> | null = null;
  private _saved: Plan | null = null;
  private _backgrounds = new Map<string, BackgroundImage>();
  private _storedBefore: string | null = null;
  private _backgroundUrls = new WeakMap<BackgroundImage, string>();
  private _savedBackdrop = new Backdrop(this);
  private _drafted: Plan | null = null;
  private _draftKey: string | null = null;
  private _draftImage: string | null = null;
  private _draftImages = new Map<string, BackgroundImage | null>();
  private _sent: { plan: Plan; rev: number } | null = null;
  private _dirtySent = false;
  private _keyRun: KeyRun | null = null;
  private _wallRoom: string | null = null;

  constructor() {
    super();
    this._version = 0;
    this._preview = null;
    this._selection = null;
    this._tool = "select";
    this._grid = 0.1;
    this._magnet = true;
    this._keepRatio = false;
    this._saving = false;
    this._conflict = null;
    this._drafts = [];
    this._importOpen = false;
    this._importKeep = true;
    this._robots = null;
    this._robotUrl = "";
    this._importText = "";
    this._importResult = null;
    this._importError = null;
    this._importBusy = false;
    this._renamedNotice = [];
    this._keepMine = null;
    this.reserved = [];
    this._listDrag = null;
    this._armed = null;
    this._narrowDismissed = false;
    this._notice = null;
    this._speak = false;
    this._menuOpen = false;
    this._exportCopy = null;
    this._showBackground = readFlag(BACKGROUND_KEY, true);
    this.addEventListener("keydown", (e) => this._key(e));
  }

  static override styles = [
    tokens,
    shared,
    css`
      :host {
        display: block;
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 12px;
        padding: 8px 12px;
        margin-bottom: 16px;
      }
      .group {
        display: inline-flex;
        align-items: center;
        gap: 2px;
      }
      .tools {
        padding: 3px;
        border-radius: 24px;
        background: var(--og-tint);
      }
      .tool {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 40px;
        min-width: 44px;
        justify-content: center;
        padding: 0 12px;
        border: none;
        border-radius: 20px;
        background: transparent;
        color: var(--og-fg2);
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: background-color 150ms var(--og-ease), color 150ms;
      }
      .tool:hover {
        color: var(--og-fg);
      }
      .tool[aria-pressed="true"] {
        background: var(--og-card);
        color: var(--og-primary);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.14);
      }
      .tool .label {
        display: none;
      }
      @media (min-width: 1180px) {
        .tool .label {
          display: inline;
        }
      }
      .sep {
        width: 1px;
        height: 28px;
        background: var(--og-divider);
      }
      .grid-select {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        color: var(--og-fg2);
      }
      .grid-select select {
        width: auto;
        min-height: 40px;
        padding: 4px 8px;
        font-size: 14px;
        border-radius: 8px;
        border: 1px solid var(--og-divider);
        background: transparent;
      }
      .spacer {
        flex: 1;
      }
      .state {
        font-size: 13px;
        color: var(--og-fg2);
        display: inline-flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
      }
      .state .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--og-warning);
      }
      .more {
        position: relative;
        display: none;
      }
      .menu {
        position: absolute;
        top: calc(100% + 4px);
        right: 0;
        z-index: 20;
        display: grid;
        min-width: 180px;
        padding: 6px;
        border-radius: 12px;
        background: var(--og-card);
        border: 1px solid var(--og-divider);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
      }
      .menu button {
        display: flex;
        align-items: center;
        gap: 12px;
        min-height: 44px;
        padding: 0 12px;
        border: none;
        border-radius: 8px;
        background: transparent;
        color: var(--og-fg);
        font-size: 14px;
        text-align: left;
        cursor: pointer;
      }
      .menu button:hover {
        background: var(--og-tint);
      }
      @media (max-width: 600px) {
        .toolbar {
          padding: 8px;
          gap: 8px 4px;
        }
        .sep,
        .grid-select > span,
        .btn .label,
        .state,
        .wide-only {
          display: none;
        }
        .more {
          display: block;
        }
        .toolbar .btn {
          padding: 0 14px;
        }
      }
      .layout {
        display: grid;
        gap: 16px;
        grid-template-columns: minmax(0, 1fr);
        align-items: start;
      }
      @media (min-width: 1024px) {
        .layout {
          grid-template-columns: minmax(0, 1fr) 320px;
        }
      }
      .canvas-card {
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      outglow-editor-canvas {
        height: clamp(380px, calc(100vh - 290px), 900px);
        border-radius: var(--og-radius) var(--og-radius) 0 0;
      }
      @media (max-width: 1023px) {
        outglow-editor-canvas {
          height: clamp(340px, 54vh, 640px);
        }
      }
      .to-inspector {
        margin-left: auto;
        flex: none;
      }
      @media (min-width: 1024px) {
        .to-inspector {
          display: none;
        }
      }
      .hint {
        display: flex;
        gap: 10px;
        align-items: center;
        padding: 10px 16px 12px;
        border-top: 1px solid var(--og-divider);
        font-size: 13px;
        line-height: 18px;
        color: var(--og-fg2);
      }
      .hint .icon {
        margin-top: 1px;
      }
      .hint.warning .icon {
        color: var(--og-warning);
      }
      .side {
        display: grid;
        gap: 16px;
        align-content: start;
      }
      @media (min-width: 1024px) {
        .side {
          position: sticky;
          top: 72px;
          max-height: calc(100vh - 88px);
          overflow: auto;
          padding-bottom: 2px;
          scrollbar-width: thin;
        }
      }
      @media (min-width: 640px) and (max-width: 1023px) {
        .side {
          grid-template-columns: 1fr 1fr;
        }
        .side > .inspector {
          grid-column: 1 / -1;
        }
      }
      .section {
        display: grid;
        gap: 14px;
        padding: 4px 16px 16px;
      }
      .swatches {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .swatches button {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: 2px solid transparent;
        cursor: pointer;
        padding: 0;
        position: relative;
        display: grid;
        place-items: center;
        color: #fff;
      }
      .swatches button::after {
        content: "";
        position: absolute;
        inset: -6px;
      }
      .swatches button[aria-checked="true"] {
        box-shadow: 0 0 0 2px var(--og-card), 0 0 0 4px currentColor;
      }
      .edges {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .edges label {
        display: grid;
        gap: 2px;
        font-size: 12px;
        color: var(--og-fg2);
      }
      .edges input {
        min-height: 40px;
        font-variant-numeric: tabular-nums;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .chips .chip {
        min-height: 36px;
      }
      .segmented {
        width: 100%;
      }
      .segmented button {
        flex: 1;
        padding: 0 8px;
      }
      .list {
        list-style: none;
        margin: 0;
        padding: 0 8px 8px;
        display: grid;
        gap: 2px;
      }
      .list button.item,
      .bulb-item {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        min-height: 48px;
        padding: 6px 10px;
        border: none;
        border-radius: 10px;
        background: transparent;
        text-align: left;
        font-size: 14px;
        cursor: pointer;
      }
      .list button.item:hover,
      .bulb-item:hover {
        background: var(--og-tint);
      }
      .list button.item[aria-current="true"] {
        background: var(--og-primary-tint);
      }
      .bulb-item {
        touch-action: none;
        cursor: grab;
        user-select: none;
        -webkit-user-select: none;
      }
      .bulb-item[aria-pressed="true"] {
        background: var(--og-primary-tint);
        color: var(--og-primary);
      }
      .bulb-item .bulb-dot {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        background: color-mix(in srgb, var(--og-motion) 16%, transparent);
        color: var(--og-motion);
        flex: none;
      }
      .bulb-item .grip {
        margin-left: auto;
        color: var(--og-fg2);
        opacity: 0.7;
      }
      .item .swatch {
        width: 12px;
        height: 12px;
        border-radius: 4px;
      }
      .item .meta {
        margin-left: auto;
        font-size: 12px;
        color: var(--og-fg2);
        font-variant-numeric: tabular-nums;
      }
      .issues {
        list-style: none;
        margin: 0;
        padding: 0 8px 8px;
        display: grid;
        gap: 2px;
      }
      .issues button {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        width: 100%;
        min-height: 44px;
        padding: 10px;
        border: none;
        border-radius: 10px;
        background: transparent;
        text-align: left;
        font-size: 13px;
        line-height: 18px;
        cursor: pointer;
      }
      .issues button:hover {
        background: var(--og-tint);
      }
      .issues li {
        display: grid;
        gap: 4px;
      }
      .issues .unpin {
        justify-self: start;
        width: auto;
        min-height: 36px;
        margin: 0 10px 6px 38px;
        padding: 6px 12px;
      }
      .pinned {
        display: grid;
        gap: 8px;
        justify-items: start;
      }
      .pinned .kv-line {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .issues .warning .icon {
        color: var(--og-warning);
      }
      .issues .error .icon {
        color: var(--og-error);
      }
      .issues .info .icon {
        color: var(--og-info);
      }
      .ok {
        display: flex;
        gap: 10px;
        align-items: center;
        padding: 0 16px 16px;
        font-size: 13px;
        color: var(--og-fg2);
      }
      .ok .icon {
        color: var(--og-success);
      }
      .drag-ghost {
        position: fixed;
        z-index: 30;
        pointer-events: none;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px 6px 6px;
        border-radius: 20px;
        background: var(--og-card);
        border: 1px solid var(--og-divider);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
        font-size: 13px;
        font-weight: 500;
        transform: translate(-14px, -50%);
      }
      .drag-ghost .bulb-dot {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        background: var(--og-motion);
        color: #fff;
      }
      .banner {
        margin-bottom: 16px;
      }
      .banner .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 8px;
      }
      .import-body {
        display: grid;
        gap: 14px;
      }
      .import-preview {
        border: 1px solid var(--og-divider);
        border-radius: 12px;
        padding: 8px;
        background: color-mix(in srgb, var(--og-fg) 2.5%, var(--og-card));
      }
      .warnings {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 6px;
      }
      .warnings li {
        display: flex;
        gap: 8px;
        font-size: 13px;
        align-items: flex-start;
      }
      .warnings .icon {
        color: var(--og-warning);
        flex: none;
      }
      .file {
        position: relative;
        overflow: hidden;
      }
      .file input {
        position: absolute;
        inset: 0;
        z-index: 1;
        opacity: 0;
        cursor: pointer;
      }
      .kv-line {
        font-size: 13px;
        color: var(--og-fg2);
        font-variant-numeric: tabular-nums;
      }
      .danger-row {
        display: flex;
        justify-content: flex-start;
      }
    `,
  ];

  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("plan") && this.plan) {
      const plan = this.plan;
      if (!this._history) {
        this._history = new History(plan, 100, samePlan);
        this._saved = plan;
        this._offerDrafts(plan);
      } else if (plan !== this._saved) {
        this._arrived(plan);
      }
    }
    const placed = this._history ? this._plan.background : null;
    const local = placed ? this._backgrounds.has(placed.file) : false;
    const saved = placed !== null && !local && this.plan?.background?.file === placed.file;
    this._savedBackdrop.show(saved ? { hass: this.hass, file: placed.file } : null);
  }

  private _arrived(plan: Plan): void {
    const history = this._history!;
    if (this._ownSave(plan)) {
      this._landed(plan);
      return;
    }
    this._sent = null;
    if (this._saved && sameContent(plan, this._saved)) {
      if (this._dirty()) this.toast(te(this.loc, "reconnected_kept"));
      else history.present = plan;
      this._saved = plan;
    } else if (!this._dirty()) {
      history.reset(plan);
      this._saved = plan;
      this._storedBefore = null;
      this._preview = null;
    } else {
      this._conflict = "remote";
    }
  }

  private _ownSave(plan: Plan): boolean {
    const sent = this._sent;
    if (sent === null || plan.rev !== sent.rev + 1) return false;
    const retired = new Set(plan.retired_rooms);
    const expected = new Set([...sent.plan.retired_rooms, ...(this.reserved ?? [])]);
    return (
      sent.plan.retired_rooms.every((id) => retired.has(id)) &&
      plan.retired_rooms.every((id) => expected.has(id)) &&
      sameContent({ ...plan, retired_rooms: [] }, { ...sent.plan, retired_rooms: [] }, true)
    );
  }

  private _landed(plan: Plan): void {
    const sent = this._sent!;
    this._sent = null;
    if (samePlan(this._history!.present, sent.plan)) {
      this._history!.present = plan;
      this._history!.seal();
    }
    this._saved = plan;
    this._conflict = null;
    this.toast(te(this.loc, "save_landed"));
  }

  private get _scope(): string {
    return this.info?.entry_id ?? "default";
  }

  private _offerDrafts(plan: Plan): void {
    const found = listDrafts(this._scope, this._draftKey);
    for (const draft of found.filter((d) => sameContent(d.plan, plan))) dropDraft(draft.key);
    this._drafts = found.filter((d) => !sameContent(d.plan, plan));
    for (const draft of this._drafts) {
      if (draft.inline) this._draftImages.set(draft.key, draft.inline);
      else if (draft.image) {
        void getImage(draft.key, draft.image).then((image) => {
          this._draftImages.set(draft.key, image);
          this.requestUpdate();
        });
      }
    }
    void sweepImages();
  }

  private _keepDraft(): void {
    const present = this._history?.present ?? null;
    if (!present || present === this._drafted) return;
    if (!this._dirty()) {
      if (this._drafted && this._draftKey) dropDraft(this._draftKey);
      this._drafted = null;
      this._draftImage = null;
      return;
    }
    this._drafted = present;
    const key = (this._draftKey ??= draftKey(this._scope));
    const imageKey = present.background ? present.background.file : null;
    const image = imageKey ? this._backgrounds.get(imageKey) : undefined;
    const local = imageKey && image ? imageKey : null;
    saveDraft(key, this.rev, present, local);
    if (local && image && local !== this._draftImage) {
      this._draftImage = local;
      void putImage(key, local, image);
    }
  }

  private _draftBackground(draft: Draft): "kept" | "lost" | "pending" {
    const placed = draft.plan.background;
    if (!placed) return "kept";
    if (draft.image) {
      if (!this._draftImages.has(draft.key)) return "pending";
      if (this._draftImages.get(draft.key)) return "kept";
    }
    return placed.file === this.plan?.background?.file ? "kept" : "lost";
  }

  private async _restoreDraft(draft: Draft): Promise<void> {
    if (!this._history) return;
    const placed = draft.plan.background;
    const image = draft.image ? (draft.inline ?? this._draftImages.get(draft.key) ?? (await getImage(draft.key, draft.image))) : null;
    if (draft.image && image) this._backgrounds.set(draft.image, image);
    const lost = placed !== null && !image && placed.file !== this.plan?.background?.file;
    const background = lost ? (this._saved?.background ?? null) : placed;
    this._drafts = this._drafts.filter((d) => d !== draft);
    this._commit({ ...draft.plan, rev: this._history.present.rev, background }, null, null);
    dropDraft(draft.key);
    this._draftImages.delete(draft.key);
    this.toast(te(this.loc, lost ? "draft_restored_lost" : "draft_restored"));
    void this.updateComplete.then(() => this._canvas?.fit());
  }

  private _discardDraft(draft: Draft): void {
    this._drafts = this._drafts.filter((d) => d !== draft);
    this._draftImages.delete(draft.key);
    dropDraft(draft.key);
  }

  private _backgroundUrl(): string | null {
    const placed = this._plan.background;
    if (!this._showBackground || !placed) return null;
    const image = this._backgrounds.get(placed.file);
    if (!image) return this._savedBackdrop.url;
    const known = this._backgroundUrls.get(image);
    if (known) return known;
    const url = imageUrl(image);
    this._backgroundUrls.set(image, url);
    return url;
  }

  private _toggleBackground(): void {
    this._showBackground = !this._showBackground;
    writeFlag(BACKGROUND_KEY, this._showBackground);
  }

  override updated(): void {
    this._keepDraft();
    const dirty = this._dirty();
    if (dirty !== this._dirtySent) {
      this._dirtySent = dirty;
      this.emit("og-dirty", { dirty });
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("pointerdown", this._outside, true);
    if (this._dirtySent) {
      this._dirtySent = false;
      this.emit("og-dirty", { dirty: false });
    }
  }

  protected override roomName(id: string | null | undefined): string {
    if (!id) return "—";
    return this._history ? (this._plan.rooms.find((r) => r.id === id)?.name ?? id) : super.roomName(id);
  }

  private _dirty(): boolean {
    return Boolean(this._history && this._saved && !samePlan(this._history.present, this._saved));
  }

  private get _plan(): Plan {
    return this._preview ?? this._history?.present ?? this.plan!;
  }

  private get _canvas(): OutglowEditorCanvas | null {
    return this.renderRoot.querySelector("outglow-editor-canvas");
  }

  private _commit(plan: Plan, key: string | null = null, selection: Selection = this._selection): void {
    if (!this._history) return;
    this._preview = null;
    const before = this._history.present;
    this._history.push(retireGone(plan, this._saved), key);
    this._selection = trackSelection(this._history.present, selection, before);
    this._version += 1;
  }

  private _watch(plan: Plan, before: Plan | undefined = this._history?.present): void {
    const moved = before ? movedBulbs(before, plan) : [];
    const loc = this.loc;
    const first = moved[0];
    const place = (room: string | null): string => (room ? this.roomName(room) : te(loc, "outside"));
    const bulbs = !first
      ? []
      : moved.length === 1
        ? [te(loc, "bulb_moved", { bulb: this.bulbName(first.ieee), from: place(first.from), to: place(first.to) })]
        : [te(loc, "bulb_moved_many", { bulbs: moved.map((k) => this.bulbName(k.ieee)).join(", ") })];
    const unpinned = before ? unpinnedBulbs(before, plan).map((k) => te(loc, "bulb_unpinned", { bulb: this.bulbName(k.ieee), from: place(k.from), to: place(k.to) })) : [];
    const touching = new Set(wallPairs(plan));
    const doors = before
      ? lostDoors(before, plan).map(([a, b]) => te(loc, touching.has(pairKey([a, b])) ? "door_squeezed" : "door_lost", { a: this.roomName(a), b: this.roomName(b) }))
      : [];
    const notes = [...bulbs, ...unpinned, ...doors];
    this._notice = notes.length ? notes.join(" ") : null;
  }

  private _undo(): void {
    if (!this._history?.canUndo) return;
    this._canvas?.cancel();
    this._preview = null;
    const before = this._history.present;
    this._revive(before, this._history.undo());
  }

  private _redo(): void {
    if (!this._history?.canRedo) return;
    this._preview = null;
    const before = this._history.present;
    this._revive(before, this._history.redo());
  }

  private _revive(before: Plan, restored: Plan): void {
    const { plan, renamed } = reviveRetired(restored, this._saved?.retired_rooms ?? []);
    if (this._history) this._history.present = plan;
    if (this._selection?.kind === "room" || this._selection?.kind === "vertex") {
      const id = this._selection.id;
      const moved = renamed.find((r) => r.from === id);
      if (moved) this._selection = { ...this._selection, id: moved.to };
    }
    this._selection = trackSelection(plan, this._selection, before);
    this._notice = null;
    this._warnRenamed(renamed);
    this._version += 1;
  }

  private _renamedText(renamed: Renamed[]): string[] {
    return renamed.length ? [te(this.loc, "renamed_rooms", { rooms: renamed.map((r) => r.name).join(", ") })] : [];
  }

  private _warnRenamed(renamed: Renamed[]): void {
    for (const text of this._renamedText(renamed)) this.toast(text);
  }

  private _setTool(tool: Tool): void {
    this._tool = tool;
    this._speak = false;
    if (tool === "bulb" && !this._armed) {
      this._armed = this._unplaced()[0]?.ieee ?? null;
    }
    if (tool !== "bulb") this._armed = null;
  }

  private _key(event: KeyboardEvent): void {
    const target = event.composedPath()[0] as HTMLElement | undefined;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || this._importOpen || this._exportCopy) {
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === "z") {
      event.preventDefault();
      if (event.shiftKey) this._redo();
      else this._undo();
      return;
    }
    if (mod && key === "y") {
      event.preventDefault();
      this._redo();
      return;
    }
    if (mod && key === "s") {
      event.preventDefault();
      void this._save();
      return;
    }
    const pick = pickKey(event);
    if (pick) {
      if (this._tool !== "select" || !(pick[0] === "corner" ? this._pickCorner(pick[1]) : this._pickWall(pick[1]))) return;
      event.preventDefault();
      return;
    }
    if (event.altKey && !mod && this._selection?.kind === "room" && event.key in RESIZE_KEYS) {
      event.preventDefault();
      const id = this._selection.id;
      const step = this._grid * (event.shiftKey ? 10 : 1);
      const [dw, dh] = RESIZE_KEYS[event.key]!;
      this._keyStep("resize", id, [dw * step, dh * step], (base, _, [tw, th]) => {
        const room = base.rooms.find((r) => r.id === id);
        if (!room) return base;
        const [x, y, w, h] = boxOf(room.outline);
        const box: Box = [x, y, Math.max(0.2, w + tw), Math.max(0.2, h + th)];
        return resizeRoom(base, id, box);
      });
      return;
    }
    if (event.altKey && this._selection && event.key in RESIZE_KEYS) {
      event.preventDefault();
      return;
    }
    if (mod || event.altKey) return;
    if (key in SHORTCUTS) {
      event.preventDefault();
      this._setTool(SHORTCUTS[key]!);
      return;
    }
    const canvas = this._canvas;
    switch (event.key) {
      case "Escape":
        if (canvas?.cancel()) break;
        this._speak = false;
        if (this._tool !== "select") this._setTool("select");
        else this._selection = null;
        break;
      case "Enter":
        if (!canvas?.finish()) return;
        break;
      case "Backspace":
      case "Delete":
        if (event.key === "Backspace" && canvas?.dropPoint()) break;
        if (!this._selection) return;
        if (this._selection.kind === "vertex") {
          this._removeCorner(this._selection.id, this._selection.index, true);
          break;
        }
        this._commit(remove(this._plan, this._selection));
        this._selection = null;
        break;
      case "+":
      case "=":
        canvas?.zoomBy(1.25);
        break;
      case "-":
        canvas?.zoomBy(0.8);
        break;
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown": {
        if (!this._selection) return;
        const step = this._grid * (event.shiftKey ? 10 : 1);
        const delta: Point =
          event.key === "ArrowLeft" ? [-step, 0] : event.key === "ArrowRight" ? [step, 0] : event.key === "ArrowUp" ? [0, -step] : [0, step];
        this._keyStep("nudge", seriesId(this._selection), delta, (base, selection, total) => nudge(base, selection, total));
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  }

  private _keyStep(family: string, id: string, step: Point, run: (base: Plan, selection: Selection, total: Point) => Plan): void {
    if (!this._history) return;
    const last = this._keyRun;
    const going = last?.family === family && last.after === this._selection && this._history.key === last.key ? last : null;
    const start = going ?? { family, key: `${family}:${id}`, base: this._plan, selection: this._selection, total: [0, 0] as Point, after: null };
    const total = add(start.total, step);
    const next = run(start.base, start.selection, total);
    if (next === start.base && Math.hypot(total[0], total[1]) > 1e-9) return;
    this._watch(next, start.base);
    this._commit(next, start.key, nudgeSelection(start.base, next, start.selection, total) ?? this._selection);
    this._keyRun = { ...start, total, after: this._selection };
  }

  private _removeCorner(id: string, index: number, keyboard = false): void {
    const next = cutCorner(this._plan, id, index);
    if (typeof next === "string") {
      this._selection = vertexSelection(this._plan, id, index);
      this._notice = te(this.loc, `corner_${next}`);
      return;
    }
    this._watch(next);
    this._commit(next, null, { kind: "room", id });
    this._canvas?.focusPlan(keyboard);
  }

  private _liveAreas(): ReadonlySet<string> | null {
    const areas = this.hass?.areas;
    return areas ? new Set(Object.values(areas).map((a) => a.area_id)) : null;
  }

  private _areaName(id: string): string {
    return Object.values(this.hass?.areas ?? {}).find((a) => a.area_id === id)?.name ?? id;
  }

  private _mergeTrouble(plan: Plan, a: string, b: string): string | null {
    const trouble = mergeTrouble(plan, a, b);
    const sides = mergeSides(plan, a, b);
    if (!trouble) return null;
    const names = { inner: this.roomName(sides?.gone.id), outer: this.roomName(sides?.keep.id) };
    return te(this.loc, trouble === "hole" ? "merge_failed" : `merge_${trouble}`, names);
  }

  private _mergeAreaNotes(plan: Plan, a: string, b: string): { area: string | null; bulbs: string | null } {
    const sides = mergeSides(plan, a, b);
    if (!sides) return { area: null, bulbs: null };
    const { keep, gone } = sides;
    const loc = this.loc;
    const kept = mergedArea(keep, gone, this._liveAreas());
    const lost = gone.area_id && gone.area_id !== kept ? gone.area_id : null;
    const names = { keep: keep.name, gone: gone.name, area: kept ? this._areaName(kept) : "", gone_area: lost ? this._areaName(lost) : "" };
    const note = lost && kept ? te(loc, "merge_area_drops", names) : kept && kept === gone.area_id && keep.area_id !== kept ? te(loc, "merge_area_takes", names) : null;
    const placed = new Set(plan.bulbs.map((x) => x.ieee));
    const stray = lost ? this.bulbs.filter((x) => x.area_id === lost && !placed.has(x.ieee)) : [];
    const bulbs = stray.length && kept ? te(loc, "merge_area_bulbs", { ...names, n: stray.length, bulbs: stray.map((x) => this.bulbName(x.ieee)).join(", ") }) : null;
    return { area: note, bulbs };
  }

  private _merge(a: string, b: string, keyboard = false): void {
    const plan = this._plan;
    const result = mergeRooms(plan, a, b, this._liveAreas());
    if (!result) {
      this._notice = this._mergeTrouble(plan, a, b);
      return;
    }
    const loc = this.loc;
    const keep = this.roomName(result.id);
    const gone = this.roomName(result.id === a ? b : a);
    const { bulbs } = this._mergeAreaNotes(plan, a, b);
    this._commit(result.plan, null, { kind: "room", id: result.id });
    const mixed = result.mixed.map((m) => te(loc, "wall_mixed", { a: keep, b: this.roomName(m.room), kind: te(loc, `kind_${m.kind}`) }));
    this._notice = [te(loc, "rooms_merged", { gone, keep }), ...mixed, ...(bulbs ? [bulbs] : [])].join(" ");
    this._canvas?.focusPlan(keyboard);
  }

  private _roomWalls(plan: Plan, id: string): number[] {
    return wallPairs(plan).flatMap((key, i) => (key?.split("|").includes(id) ? [i] : []));
  }

  private _spoken(): string {
    const sel = this._selection;
    const plan = this._history?.present;
    if (!this._speak || !plan) return "";
    const loc = this.loc;
    if (sel?.kind === "vertex") {
      const room = plan.rooms.find((r) => r.id === sel.id);
      const point = room?.outline[sel.index];
      return room && point ? te(loc, "corner_picked", { n: sel.index + 1, room: room.name, x: fmtNumber(loc, point[0], 2), y: fmtNumber(loc, point[1], 2) }) : "";
    }
    if (sel?.kind !== "wall") return "";
    const index = wallIndex(plan, sel);
    const ends = wallEnds(plan, index);
    const wall = plan.walls[index];
    if (!ends || !wall) return "";
    const id = ends.includes(this._wallRoom ?? "") ? this._wallRoom! : ends[0];
    const walls = this._roomWalls(plan, id);
    return te(loc, "wall_picked", {
      k: walls.indexOf(index) + 1,
      n: walls.length,
      room: this.roomName(id),
      a: this.roomName(ends[0]),
      b: this.roomName(ends[1]),
      length: fmtNumber(loc, dist(wall.a, wall.b), 2),
    });
  }

  private _pickCorner(step: 1 | -1): boolean {
    const sel = this._selection;
    const room = sel?.kind === "room" || sel?.kind === "vertex" ? this._plan.rooms.find((r) => r.id === sel.id) : undefined;
    if (!room) return false;
    const n = room.outline.length;
    const from = sel?.kind === "vertex" ? sel.index : step > 0 ? -1 : 0;
    const index = (from + step + n) % n;
    this._selection = vertexSelection(this._plan, room.id, index);
    this._notice = null;
    this._speak = true;
    return true;
  }

  private _pickWall(step: 1 | -1): boolean {
    const sel = this._selection;
    const plan = this._plan;
    const pairs = wallPairs(plan);
    const current = sel?.kind === "wall" ? wallIndex(plan, sel) : -1;
    const ends = pairs[current]?.split("|") ?? [];
    const id = sel?.kind === "room" || sel?.kind === "vertex" ? sel.id : ends.includes(this._wallRoom ?? "") ? this._wallRoom : ends[0];
    const walls = id ? this._roomWalls(plan, id) : [];
    if (!id || walls.length === 0) return false;
    const from = current >= 0 ? walls.indexOf(current) : step > 0 ? -1 : 0;
    const index = walls[(from + step + walls.length) % walls.length]!;
    this._wallRoom = id;
    this._selection = wallSelection(plan, index);
    this._notice = null;
    this._speak = true;
    return true;
  }

  private _unplaced() {
    const placed = new Set(this._plan.bulbs.map((b) => b.ieee));
    return this.bulbs.filter((b) => !placed.has(b.ieee));
  }

  private _onEdit(event: CustomEvent<{ plan: Plan; final: boolean; selection?: Selection }>): void {
    if (event.detail.selection !== undefined) this._selection = event.detail.selection;
    this._watch(event.detail.plan);
    if (event.detail.final) {
      this._commit(event.detail.plan);
    } else {
      this._preview = event.detail.plan;
    }
  }

  private _onPlace(event: CustomEvent<{ point: Point }>): void {
    const ieee = this._armed ?? this._unplaced()[0]?.ieee;
    if (!ieee) {
      this.toast(te(this.loc, "no_bulb_to_place"));
      return;
    }
    this._commit(placeBulb(this._plan, ieee, event.detail.point));
    const next = this._unplaced()[0]?.ieee ?? null;
    this._armed = next;
    if (!next) {
      this._tool = "select";
      this._selection = { kind: "bulb", ieee };
    }
  }

  private _listDown(event: PointerEvent, ieee: string): void {
    if (event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this._listDrag = {
      ieee,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      sx: event.clientX,
      sy: event.clientY,
      moved: false,
      point: null,
    };
  }

  private _listMove(event: PointerEvent): void {
    const drag = this._listDrag;
    if (!drag || drag.pointer !== event.pointerId) return;
    const moved = drag.moved || Math.hypot(event.clientX - drag.sx, event.clientY - drag.sy) > 6;
    const raw = moved ? (this._canvas?.toPlan(event.clientX, event.clientY) ?? null) : null;
    const point = raw && this._canvas ? this._canvas.snapBulb(raw) : null;
    this._listDrag = { ...drag, x: event.clientX, y: event.clientY, moved, point };
  }

  private _listUp(event: PointerEvent): void {
    const drag = this._listDrag;
    if (!drag || drag.pointer !== event.pointerId) return;
    this._listDrag = null;
    if (drag.moved && drag.point) {
      this._commit(placeBulb(this._plan, drag.ieee, drag.point));
      this._selection = { kind: "bulb", ieee: drag.ieee };
      this._tool = "select";
      this._armed = null;
      return;
    }
    if (!drag.moved) {
      if (this._armed === drag.ieee && this._tool === "bulb") {
        this._armed = null;
        this._tool = "select";
      } else {
        this._armed = drag.ieee;
        this._tool = "bulb";
      }
    }
  }

  private _listKey(event: KeyboardEvent, ieee: string): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      this._armed = ieee;
      this._tool = "bulb";
    }
  }

  private async _upload(plan: Plan, always: boolean): Promise<BackgroundUpload | null> {
    const file = plan.background?.file;
    const stored = file === this._saved?.background?.file || file === this._storedBefore;
    const image = file && (always || !stored) ? this._backgrounds.get(file) : undefined;
    if (!image) return null;
    const packed = toBase64(await deflate(fromBase64(image.data_base64)));
    if (!fits(packed.length, utf8Length(JSON.stringify(plan)))) {
      throw new Error(te(this.loc, "background_too_large", { size: megabytes(packed.length), limit: megabytes(MESSAGE_MAX) }));
    }
    return { mime: image.mime, data_base64: packed, deflated: true };
  }

  private async _save(force = false): Promise<void> {
    if (!this._history || this._saving || (!force && !this._dirty())) return;
    this._saving = true;
    const before = this._saved ?? this._history.present;
    let rev = this.rev;
    let storedFile = this._saved?.background?.file ?? null;
    try {
      let retired = before.retired_rooms;
      if (force) {
        const server = await this.call("outglow/plan/get", {});
        rev = server.rev;
        retired = retiredOver(before, server.plan);
        storedFile = server.plan.background?.file ?? null;
      }
      const { plan, renamed } = reviveRetired(retireGone(this._history.present, before), retired);
      if (renamed.length) this._history.push(plan);
      let background_image = await this._upload(plan, force);
      this._sent = { plan, rev };
      let result = await this.call("outglow/plan/save", { rev, plan: { ...plan, rev }, background_image });
      if (plan.background && !result.background && !background_image) {
        background_image = await this._upload(plan, true);
        if (background_image) {
          storedFile = null;
          this._sent = { plan, rev: result.rev };
          result = await this.call("outglow/plan/save", { rev: result.rev, plan: { ...plan, rev: result.rev }, background_image });
        }
      }
      this._sent = null;
      this._renamedNotice = renamed;
      if (this._saved?.rev === result.rev) return;
      const lost = Boolean(plan.background && !result.background);
      const saved: Plan = { ...plan, rev: result.rev, background: result.background, retired_rooms: result.retired_rooms };
      this._storedBefore = lost ? null : storedFile;
      this._history.present = saved;
      this._history.seal();
      this._saved = saved;
      this._conflict = null;
      this._keepMine = null;
      this.planSaved(saved, result.rev);
      this.toast(te(this.loc, lost ? "background_lost" : "saved"));
    } catch (err) {
      const code = errorCode(err);
      if (code === "rev_conflict") {
        this._sent = null;
        this._conflict = "save";
        void this._previewKeepMine(before);
      } else if (code === "invalid_format") {
        this.toast(te(this.loc, "save_invalid", { message: String((err as { message?: string }).message ?? "") }), true);
      } else {
        this.fail(err);
      }
    } finally {
      this._saving = false;
      this._version += 1;
    }
  }

  private async _previewKeepMine(before: Plan): Promise<void> {
    this._keepMine = null;
    try {
      const server = (await this.call("outglow/plan/get", {})).plan;
      if (!this._history) return;
      const { plan, renamed } = reviveRetired(retireGone(this._history.present, before), retiredOver(before, server));
      const kept = new Set(plan.rooms.map((r) => r.id));
      this._keepMine = { removes: server.rooms.filter((r) => !kept.has(r.id)).map((r) => r.name), renames: renamed.map((r) => r.name) };
    } catch {
      this._keepMine = null;
    }
  }

  private _keepMineText(): string[] {
    const info = this._keepMine;
    if (!info) return [];
    const out: string[] = [];
    if (info.removes.length) out.push(te(this.loc, "conflict_removes", { rooms: info.removes.join(", ") }));
    out.push(info.renames.length ? te(this.loc, "conflict_renames", { rooms: info.renames.join(", ") }) : te(this.loc, "conflict_same"));
    return out;
  }

  private async _reload(): Promise<void> {
    try {
      const result = await this.call("outglow/plan/get", {});
      this.reserved = result.reserved_rooms;
      this._history?.reset(result.plan);
      this._saved = result.plan;
      this._storedBefore = null;
      this._preview = null;
      this._selection = null;
      this._conflict = null;
      this._keepMine = null;
      this.planSaved(result.plan, result.rev);
      this._version += 1;
      await this.updateComplete;
      this._canvas?.fit();
    } catch (err) {
      this.fail(err);
    }
  }

  private async _readFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this._importText = await file.text();
    input.value = "";
    void this._runImport();
  }

  private _current(): Plan | null {
    return this._importKeep && this._plan.bulbs.length ? this._plan : null;
  }

  private _importFailed(err: unknown): void {
    const code = errorCode(err);
    const message = String((err as { message?: string }).message ?? err);
    if (code === "fetch_failed") this._importError = te(this.loc, "fetch_failed", { message });
    else if (code === "not_found") this._importError = te(this.loc, "fetch_not_found");
    else if (code === "invalid_format" || code === "unsupported") this._importError = `${tc(this.loc, `error_${code}`)} ${message}`;
    else this._importError = tc(this.loc, "error_other", { message });
  }

  private async _importBody(current: Plan | null): Promise<{ text: string } | { deflated_base64: string } | null> {
    const text = this._importText;
    const besides = current ? utf8Length(JSON.stringify(current)) : 0;
    const size = utf8Length(text);
    if (size <= INLINE_MAX && fits(size, besides)) return { text };
    const packed = toBase64(await deflate(new TextEncoder().encode(text)));
    if (fits(packed.length, besides)) return { deflated_base64: packed };
    this._importError = te(this.loc, "too_large", { size: megabytes(packed.length), limit: megabytes(MESSAGE_MAX) });
    return null;
  }

  private async _runImport(): Promise<void> {
    if (!this._importText.trim()) return;
    this._importError = null;
    this._importResult = null;
    this._importBusy = true;
    try {
      const current = this._current();
      const body = await this._importBody(current);
      if (body) this._importResult = await this.call("outglow/plan/import", { format: "auto", ...body, current });
    } catch (err) {
      this._importFailed(err);
    } finally {
      this._importBusy = false;
    }
  }

  private async _openRobots(): Promise<void> {
    this._importError = null;
    try {
      this._robots = await this.call("outglow/plan/valetudo/robots", {});
      this._robotUrl = this._robots.url ?? "";
    } catch (err) {
      this._importFailed(err);
    }
  }

  private async _fetchMap(source: { robot: string } | { url: string }): Promise<void> {
    this._importBusy = true;
    this._importError = null;
    this._importResult = null;
    try {
      this._importResult = await this.call("outglow/plan/valetudo/fetch", { ...source, current: this._current() });
    } catch (err) {
      this._importFailed(err);
    } finally {
      this._importBusy = false;
    }
  }

  private async _useImport(): Promise<void> {
    const result = this._importResult;
    if (!result) return;
    const imported = result.plan;
    if (result.background_image && imported.background) {
      this._backgrounds.delete(imported.background.file);
      this._backgrounds.set(imported.background.file, result.background_image);
      while (this._backgrounds.size > KEPT_BACKGROUNDS) this._backgrounds.delete(this._backgrounds.keys().next().value!);
    }
    const { plan, renamed } = importPlan(this._plan, imported, this._saved);
    this._commit(plan);
    this._selection = null;
    this._importOpen = false;
    this._importResult = null;
    this._importText = "";
    this._robots = null;
    this.toast([te(this.loc, "imported"), ...this._renamedText(renamed)].join(" "));
    await this.updateComplete;
    this._canvas?.fit();
  }

  private _keptText(): string {
    const kept = this._importResult?.kept;
    if (!kept) return "";
    if (!kept.aligned) {
      const key = kept.rooms === 1 ? "kept_one_room" : kept.rooms === 2 ? "kept_two_rooms" : "kept_unaligned";
      return te(this.loc, key, { bulbs: kept.bulbs });
    }
    return te(this.loc, "kept_aligned", {
      bulbs: kept.bulbs,
      rooms: kept.rooms,
      rotation: fmtNumber(this.loc, Math.round(kept.rotation_deg)),
      mirrored: kept.mirrored ? te(this.loc, "kept_mirrored") : "",
      rms: kept.rms_m === null ? "—" : fmtNumber(this.loc, kept.rms_m, 2),
    });
  }

  private _robotPanel() {
    const loc = this.loc;
    const robots = this._robots;
    if (!robots) return nothing;
    const suggested = [...new Set(robots.robots.flatMap((robot) => (robot.url ? [robot.url] : [])))];
    return html`<div class="robots" style="display:grid;gap:8px">
      ${robots.robots.length
        ? html`<div class="row wrap">
            ${robots.robots.map(
              (robot) => html`<button class="btn tonal" data-robot=${robot.id} ?disabled=${this._importBusy}
                @click=${() => void this._fetchMap({ robot: robot.id })}>${icon(mdiRobotVacuum, 18)} ${te(loc, "fetch_from", { name: robot.name })}</button>`,
            )}
          </div>`
        : nothing}
      <div class="row wrap" style="align-items:flex-end">
        <label class="field" style="flex:1;min-width:200px">${te(loc, "robot_address")}
          <input type="url" data-field="robot-url" list="robot-urls" placeholder=${suggested[0] ?? "http://192.168.1.50"} .value=${this._robotUrl}
            @input=${(e: Event) => (this._robotUrl = (e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter" && this._robotUrl.trim()) void this._fetchMap({ url: this._robotUrl });
            }} />
        </label>
        <button class="btn outlined" ?disabled=${!this._robotUrl.trim() || this._importBusy}
          @click=${() => void this._fetchMap({ url: this._robotUrl })}>${te(loc, "fetch")}</button>
        <datalist id="robot-urls">${suggested.map((url) => html`<option value=${url}></option>`)}</datalist>
      </div>
      <span class="hint" style="font-size:12px;opacity:.75">${te(loc, "robot_hint")}</span>
    </div>`;
  }

  private _issueTarget(issue: Issue): Selection {
    if (issue.bulb) return { kind: "bulb", ieee: issue.bulb };
    if (issue.room) return { kind: "room", id: issue.room };
    return null;
  }

  private _issueText(issue: Issue): string {
    return te(this.loc, `issue_${issue.code}`, {
      room: this.roomName(issue.room),
      other: issue.other ? this.roomName(issue.other) : te(this.loc, "outside"),
      bulb: issue.bulb ? this.bulbName(issue.bulb) : "",
    });
  }

  override render() {
    if (!this._history || !this.plan) {
      return html`<div class="empty-state">${tc(this.loc, "loading")}</div>`;
    }
    const loc = this.loc;
    const plan = this._plan;
    const issues = validate(plan);
    const flagged = new Set<string>();
    for (const issue of issues) {
      if (issue.severity === "info") continue;
      if (issue.room) flagged.add(issue.room);
      if (issue.other) flagged.add(issue.other);
      if (issue.bulb) flagged.add(issue.bulb);
    }
    const narrow = this.narrow && window.innerWidth <= 600;
    const ghost = this._listDrag?.point ? { ieee: this._listDrag.ieee, point: this._listDrag.point } : null;
    return html`
      ${this._toolbar()}
      ${narrow && !this._narrowDismissed
        ? html`<div class="notice info banner" role="note">
            ${icon(mdiInformation, 20)}
            <div class="grow">${te(loc, "narrow")}</div>
            <button class="btn" @click=${() => (this._narrowDismissed = true)}>${te(loc, "dismiss")}</button>
          </div>`
        : nothing}
      ${this._renamedNotice.length
        ? html`<div class="notice warning banner renamed" role="alert">
            ${icon(mdiAlert, 20)}
            <div class="grow">${this._renamedText(this._renamedNotice)}</div>
            <button class="btn" @click=${() => (this._renamedNotice = [])}>${te(loc, "dismiss")}</button>
          </div>`
        : nothing}
      ${this._drafts.map(
        (draft) => html`<div class="notice info banner" role="alert" data-notice="draft">
          ${icon(mdiRestore, 20)}
          <div class="grow">
            ${te(loc, "draft_found", { when: fmtDateTime(loc, draft.at / 1000) })}
            ${draft.rev !== this.rev ? html` ${te(loc, "draft_stale")}` : nothing}
            ${this._draftBackground(draft) === "lost" ? html` ${te(loc, "draft_background_lost")}` : nothing}
            <div class="actions">
              <button class="btn tonal" data-action="draft-restore" @click=${() => void this._restoreDraft(draft)}>${icon(mdiRestore, 18)} ${te(loc, "draft_restore")}</button>
              <button class="btn outlined neutral" data-action="draft-discard" @click=${() => this._discardDraft(draft)}>${te(loc, "draft_discard")}</button>
            </div>
          </div>
        </div>`,
      )}
      ${this._conflict
        ? html`<div class="notice warning banner" role="alert" data-notice="conflict">
            ${icon(mdiAlert, 20)}
            <div class="grow">
              ${te(loc, this._conflict === "remote" ? "conflict_remote" : "conflict")}
              ${this._keepMineText().map((text) => html`<div class="keep-mine">${text}</div>`)}
              <div class="actions">
                <button class="btn tonal" @click=${() => void this._reload()}>${icon(mdiRefresh, 18)} ${te(loc, "reload")}</button>
                <button class="btn outlined neutral" @click=${() => void this._save(true)}>${te(loc, "overwrite")}</button>
              </div>
            </div>
          </div>`
        : nothing}
      <div class="layout">
        <section class="card canvas-card" aria-label=${te(loc, "title")}>
          <outglow-editor-canvas
            .plan=${plan}
            .background=${this._backgroundUrl()}
            .dark=${this.dark}
            .tool=${this._tool}
            .grid=${this._grid}
            .magnet=${this._magnet}
            .selection=${this._selection}
            .loc=${loc}
            .names=${this.names()}
            .ghost=${ghost}
            .flagged=${flagged}
            .keepRatio=${this._keepRatio}
            .reserved=${this.reserved}
            @edit=${this._onEdit}
            @select=${(e: CustomEvent<{ selection: Selection }>) => {
              this._selection = e.detail.selection;
              this._notice = null;
              this._speak = false;
            }}
            @tool=${(e: CustomEvent<{ tool: Tool }>) => this._setTool(e.detail.tool)}
            @place=${this._onPlace}
            @remove-corner=${(e: CustomEvent<{ id: string; index: number }>) => this._removeCorner(e.detail.id, e.detail.index)}
          ></outglow-editor-canvas>
          <div class="hint ${this._notice ? "warning" : ""}">
            ${icon(this._notice ? mdiAlert : mdiInformation, 18)}<span class="hint-text">${this._notice ?? this._hint()}</span>
            <span class="sr-only" role="status">${this._notice ?? (this._spoken() || this._hint())}</span>
            ${this._selection
              ? html`<button class="btn tonal to-inspector" @click=${() => this.renderRoot.querySelector(".inspector")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                  ${te(loc, "edit_selection")}
                </button>`
              : nothing}
          </div>
        </section>
        <div class="side">
          <section class="card inspector" aria-label=${te(loc, "plan_card")}>${this._inspector(plan)}</section>
          ${this._unplacedCard()} ${this._issuesCard(issues)}
        </div>
      </div>
      ${this._importSheet()} ${this._exportCopy ? this._exportSheet(this._exportCopy) : nothing}
      ${this._listDrag?.moved
        ? html`<div class="drag-ghost" style="left:${this._listDrag.x}px;top:${this._listDrag.y}px" aria-hidden="true">
            <span class="bulb-dot">${icon(mdiLightbulb, 16)}</span>${this.bulbName(this._listDrag.ieee)}
          </div>`
        : nothing}
    `;
  }

  private _hint(): string {
    const loc = this.loc;
    if (this._tool === "bulb") {
      const ieee = this._armed ?? this._unplaced()[0]?.ieee;
      return ieee ? te(loc, "hint_bulb", { name: this.bulbName(ieee) }) : te(loc, "hint_bulb_none");
    }
    const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    if (this._tool === "select" && this._selection?.kind === "room") return te(loc, touch ? "hint_room_touch" : "hint_room");
    if (this._tool === "select" && this._selection?.kind === "vertex") return te(loc, touch ? "hint_vertex_touch" : "hint_vertex");
    if (this._tool === "select" && this._selection?.kind === "wall") return te(loc, "hint_wall");
    return te(loc, `hint_${this._tool}`);
  }

  private async _export(): Promise<void> {
    const name = exportName(new Date());
    const text = exportText(this._plan);
    if (inApp()) {
      const file = new File([text], name, { type: "application/json" });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: name });
          return;
        } catch (err) {
          if ((err as DOMException).name === "AbortError") return;
        }
      }
      this._exportCopy = { name, text };
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.style.display = "none";
    this.renderRoot.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.toast(te(this.loc, "exported", { file: name }));
  }

  private async _copyExport(): Promise<void> {
    const text = this._exportCopy?.text;
    if (text === undefined) return;
    try {
      await navigator.clipboard.writeText(text);
      this.toast(te(this.loc, "copied"));
    } catch {
      const area = this.renderRoot.querySelector<HTMLTextAreaElement>("og-sheet textarea[data-field=export]");
      area?.focus();
      area?.select();
    }
  }

  private _exportSheet(copy: { name: string; text: string }) {
    const loc = this.loc;
    return html`<og-sheet
      wide
      open
      heading=${te(loc, "export_sheet")}
      close-label=${tc(loc, "close")}
      @closed=${() => (this._exportCopy = null)}
    >
      <div class="import-body">
        <p class="small muted">${te(loc, "export_copy_hint", { file: copy.name })}</p>
        <textarea data-field="export" readonly aria-label=${te(loc, "export_sheet")} .value=${copy.text}></textarea>
      </div>
      <div slot="actions" class="row wrap" style="justify-content:flex-end;width:100%">
        <button class="btn" @click=${() => (this._exportCopy = null)}>${tc(loc, "close")}</button>
        <button class="btn filled" @click=${() => void this._copyExport()}>${icon(mdiContentCopy, 18)} ${te(loc, "copy")}</button>
      </div>
    </og-sheet>`;
  }

  private async _toggleMenu(): Promise<void> {
    this._menuOpen = !this._menuOpen;
    if (!this._menuOpen) return;
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLElement>(".menu [role=menuitem]")?.focus({ focusVisible: false } as FocusOptions);
  }

  private _closeMenu(refocus: boolean): void {
    this._menuOpen = false;
    if (refocus) this.renderRoot.querySelector<HTMLElement>("[data-action=more]")?.focus();
  }

  private _menuPick(action: () => void): void {
    this._closeMenu(false);
    action();
  }

  private _menuBlur(event: FocusEvent): void {
    const next = event.relatedTarget as Node | null;
    if (next && !(event.currentTarget as HTMLElement).contains(next)) this._menuOpen = false;
  }

  private _outside = (event: PointerEvent): void => {
    const more = this.renderRoot.querySelector(".more");
    if (more && !event.composedPath().includes(more)) this._menuOpen = false;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    keepAlive();
    window.addEventListener("pointerdown", this._outside, true);
  }

  private _menuKey(event: KeyboardEvent): void {
    if (!this._menuOpen) return;
    const items = [...this.renderRoot.querySelectorAll<HTMLElement>(".menu [role=menuitem]")];
    const at = items.indexOf((this.renderRoot as ShadowRoot).activeElement as HTMLElement);
    const step: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };
    if (event.key === "Escape") {
      this._closeMenu(true);
    } else if (event.key in step) {
      items[(at + step[event.key]! + items.length) % items.length]?.focus();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  private _toolbar() {
    const loc = this.loc;
    const history = this._history!;
    const dirty = this._dirty();
    return html`<div class="card toolbar" role="toolbar" aria-label=${te(loc, "title")}>
      <div class="group tools" role="group">
        ${TOOLS.map(
          (tool) => html`<button
            class="tool"
            aria-pressed=${this._tool === tool.id}
            title=${te(loc, "shortcut", { label: te(loc, `tool_${tool.id}`), key: tool.key })}
            aria-label=${te(loc, `tool_${tool.id}`)}
            aria-keyshortcuts=${tool.key}
            data-tool=${tool.id}
            @click=${() => this._setTool(tool.id)}
          >
            ${icon(tool.icon, 20)}<span class="label">${te(loc, `tool_${tool.id}`)}</span>
          </button>`,
        )}
      </div>
      <div class="group">
        <button class="icon-btn" title=${te(loc, "shortcut", { label: te(loc, "undo"), key: "Ctrl+Z" })} aria-label=${te(loc, "undo")}
          ?disabled=${!history.canUndo} @click=${() => this._undo()}>${icon(mdiUndo)}</button>
        <button class="icon-btn" title=${te(loc, "shortcut", { label: te(loc, "redo"), key: "Ctrl+Shift+Z" })} aria-label=${te(loc, "redo")}
          ?disabled=${!history.canRedo} @click=${() => this._redo()}>${icon(mdiRedo)}</button>
      </div>
      <span class="sep" aria-hidden="true"></span>
      <label class="grid-select">
        <span>${te(loc, "grid")}</span>
        <select aria-label=${te(loc, "grid")} .value=${String(this._grid)} @change=${(e: Event) => (this._grid = Number((e.target as HTMLSelectElement).value))}>
          ${GRIDS.map((g) => html`<option value=${String(g)} ?selected=${g === this._grid}>${te(loc, "grid_value", { n: Math.round(g * 100) })}</option>`)}
        </select>
      </label>
      <button class="icon-btn" aria-pressed=${this._magnet} title=${te(loc, "magnet")} aria-label=${te(loc, "magnet")}
        @click=${() => (this._magnet = !this._magnet)}>${icon(mdiMagnet)}</button>
      <button class="icon-btn" data-action="keep-ratio" aria-pressed=${this._keepRatio} title=${te(loc, "keep_ratio")} aria-label=${te(loc, "keep_ratio")}
        @click=${() => (this._keepRatio = !this._keepRatio)}>${icon(mdiAspectRatio)}</button>
      ${this._plan.background
        ? html`<button class="icon-btn" data-action="background" aria-pressed=${this._showBackground} title=${te(loc, "background_layer")}
            aria-label=${te(loc, "background_layer")} @click=${() => this._toggleBackground()}>${icon(mdiImage)}</button>`
        : nothing}
      <span class="spacer"></span>
      ${dirty ? html`<span class="state"><span class="dot"></span>${te(loc, "unsaved")}</span>` : nothing}
      <button class="btn tonal wide-only" aria-label=${te(loc, "import")} title=${te(loc, "import")} @click=${() => (this._importOpen = true)}>
        ${icon(mdiImport, 18)}<span class="label">${te(loc, "import")}</span>
      </button>
      <button class="btn tonal wide-only" data-action="export" aria-label=${te(loc, "export")} title=${te(loc, "export_title")} @click=${() => void this._export()}>
        ${icon(mdiExport, 18)}<span class="label">${te(loc, "export")}</span>
      </button>
      <div class="more" @focusout=${this._menuBlur} @keydown=${this._menuKey}>
        <button class="icon-btn" data-action="more" aria-label=${te(loc, "more")} title=${te(loc, "more")} aria-haspopup="menu" aria-expanded=${this._menuOpen}
          @click=${() => this._toggleMenu()}>${icon(mdiDotsVertical)}</button>
        ${this._menuOpen
          ? html`<div class="menu" role="menu" aria-label=${te(loc, "more")}>
              <button role="menuitem" @click=${() => this._menuPick(() => (this._importOpen = true))}>${icon(mdiImport, 20)}${te(loc, "import")}</button>
              <button role="menuitem" title=${te(loc, "export_title")} @click=${() => this._menuPick(() => void this._export())}>${icon(mdiExport, 20)}${te(loc, "export")}</button>
            </div>`
          : nothing}
      </div>
      <button class="btn filled" data-action="save" ?disabled=${!dirty || this._saving} @click=${() => void this._save()}>
        ${icon(dirty ? mdiContentSave : mdiCheck, 18)} ${this._saving ? tc(loc, "saving") : dirty ? te(loc, "save") : te(loc, "saved")}
      </button>
    </div>`;
  }

  private _inspector(plan: Plan) {
    const sel = this._selection;
    if (sel?.kind === "room") return this._roomInspector(plan, sel.id);
    if (sel?.kind === "wall") return this._wallInspector(plan, wallIndex(plan, sel));
    if (sel?.kind === "vertex") return this._vertexInspector(plan, sel.id, sel.index);
    if (sel?.kind === "door") return this._doorInspector(plan, sel.index);
    if (sel?.kind === "bulb") return this._bulbInspector(plan, sel.ieee);
    return this._roomsList(plan);
  }

  private _roomsList(plan: Plan) {
    const loc = this.loc;
    return html`<div class="card-head">
        <h2 class="headline">${te(loc, "plan_card")}</h2>
        <span class="badge">${te(loc, "rooms_count", { n: plan.rooms.length })}</span>
      </div>
      ${plan.rooms.length
        ? html`<ul class="list">
            ${plan.rooms.map((room) => {
              const count = plan.bulbs.filter((b) => bulbRoom(plan, b) === room.id).length;
              return html`<li>
                <button class="item" @click=${() => (this._selection = { kind: "room", id: room.id })}>
                  <span class="swatch" style="background:${room.colour}"></span>
                  <span>${room.name}</span>
                  <span class="meta">${fmtNumber(loc, area(room.outline), 1)} m² · ${te(loc, "bulbs_count", { n: count })}</span>
                </button>
              </li>`;
            })}
          </ul>`
        : nothing}
      <p class="ok" style="padding-top:4px">${te(loc, "no_selection")}</p>`;
  }

  private _roomInspector(plan: Plan, id: string) {
    const loc = this.loc;
    const room = plan.rooms.find((r) => r.id === id);
    if (!room) return nothing;
    const lengths = edgeLengths(room.outline);
    const perimeter = lengths.reduce((a, b) => a + b, 0);
    const areas = Object.values(this.hass?.areas ?? {});
    return html`<div class="card-head">
        <span class="swatch" style="background:${room.colour};width:14px;height:14px;border-radius:4px"></span>
        <h2 class="headline">${te(loc, "room")}</h2>
      </div>
      <div class="section">
        <label class="field">${te(loc, "name")}
          <input type="text" data-field="room-name" .value=${room.name}
            @input=${(e: Event) => this._commit(updateRoom(this._plan, id, { name: (e.target as HTMLInputElement).value }), `name:${id}`)} />
        </label>
        ${looksRetired(room, [...(this._saved?.retired_rooms ?? []), ...plan.retired_rooms])
          ? html`<div class="notice warning" role="note" data-field="new-entities">${icon(mdiAlert, 20)}<span>${te(loc, "new_entities", { entity: `binary_sensor.outglow_room_${room.id}_occupancy` })}</span></div>`
          : nothing}
        <label class="field">${te(loc, "area")}
          <select @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            this._commit(updateRoom(this._plan, id, { area_id: value || null }));
          }}>
            <option value="" ?selected=${room.area_id === null}>${te(loc, "area_none")}</option>
            ${areas.map((a) => html`<option value=${a.area_id} ?selected=${a.area_id === room.area_id}>${a.name}</option>`)}
            ${room.area_id && !areas.some((a) => a.area_id === room.area_id) ? html`<option value=${room.area_id} selected>${room.area_id}</option>` : nothing}
          </select>
        </label>
        <div class="field" style="display:grid;gap:8px">
          <span class="eyebrow">${te(loc, "colour")}</span>
          <div class="swatches" role="radiogroup" aria-label=${te(loc, "colour")}>
            ${ROOM_PALETTE.map(
              (c) => html`<button role="radio" aria-checked=${room.colour.toLowerCase() === c} aria-label=${c}
                style="background:${c};color:${c}" @click=${() => this._commit(updateRoom(this._plan, id, { colour: c }))}>
                ${room.colour.toLowerCase() === c ? html`<span style="color:#fff">${icon(mdiCheck, 18)}</span>` : nothing}
              </button>`,
            )}
          </div>
        </div>
        <label class="check">
          <input type="checkbox" .checked=${room.entrance} @change=${(e: Event) => this._commit(updateRoom(this._plan, id, { entrance: (e.target as HTMLInputElement).checked }))} />
          <span>${te(loc, "entrance")}</span>
        </label>
        <div class="kv-line">${te(loc, "size", { area: fmtNumber(loc, area(room.outline), 2), perimeter: fmtNumber(loc, perimeter, 2) })}</div>
        <div style="display:grid;gap:8px">
          <span class="eyebrow">${te(loc, "walls_of_room")}</span>
          <div class="edges">
            ${lengths.map(
              (length, i) => html`<label>${te(loc, "edge", { n: i + 1 })}
                <input type="number" min="0.1" step="0.01" .value=${length.toFixed(2)}
                  @change=${(e: Event) => {
                    const value = Number((e.target as HTMLInputElement).value.replace(",", "."));
                    if (Number.isFinite(value) && value > 0.05) this._commit(setEdgeLength(this._plan, id, i, value));
                  }} />
              </label>`,
            )}
          </div>
        </div>
        <div class="danger-row">
          <button class="btn outlined danger" @click=${() => {
            this._commit(removeRoom(this._plan, id));
            this._selection = null;
          }}>${icon(mdiDelete, 18)} ${te(loc, "delete_room")}</button>
        </div>
      </div>`;
  }

  private _vertexInspector(plan: Plan, id: string, index: number) {
    const loc = this.loc;
    const room = plan.rooms.find((r) => r.id === id);
    const point = room?.outline[index];
    if (!room || !point) return nothing;
    const few = room.outline.length <= 3;
    return html`<div class="card-head">
        <span class="swatch" style="background:${room.colour};width:14px;height:14px;border-radius:4px"></span>
        <h2 class="headline">${te(loc, "corner")}</h2>
      </div>
      <div class="section">
        <div class="kv-line">
          ${te(loc, "corner_of", { n: index + 1, room: room.name })}<br />
          ${te(loc, "corner_at", { x: fmtNumber(loc, point[0], 2), y: fmtNumber(loc, point[1], 2) })}
        </div>
        ${few ? html`<p class="ok">${te(loc, "corner_min")}</p>` : nothing}
        <div class="danger-row">
          <button class="btn outlined danger" data-action="remove-corner" ?disabled=${few} @click=${(e: MouseEvent) => this._removeCorner(id, index, e.detail === 0)}>
            ${icon(mdiDelete, 18)} ${te(loc, "remove_corner")}
          </button>
        </div>
      </div>`;
  }

  private _doorEdit(plan: Plan, index: number, key: string | null = null): void {
    this._commit(plan, key, doorSelection(plan, index));
  }

  private _wallInspector(plan: Plan, index: number) {
    const loc = this.loc;
    const wall = plan.walls[index];
    if (!wall) return nothing;
    const pair = wallEnds(plan, index);
    const length = dist(wall.a, wall.b);
    const trouble = pair ? this._mergeTrouble(plan, pair[0], pair[1]) : null;
    const sides = pair && !trouble ? mergeSides(plan, pair[0], pair[1]) : null;
    const notes = pair && sides ? this._mergeAreaNotes(plan, pair[0], pair[1]) : null;
    const loses = sides ? [te(loc, "merge_loses", { gone: this.roomName(sides.gone.id) }), notes?.area, notes?.bulbs].filter(Boolean).join(" ") : null;
    return html`<div class="card-head"><h2 class="headline">${te(loc, "wall")}</h2></div>
      <div class="section">
        <div class="kv-line">
          ${pair ? te(loc, "wall_between", { a: this.roomName(pair[0]), b: this.roomName(pair[1]) }) : nothing}<br />
          ${te(loc, "wall_length", { n: fmtNumber(loc, length, 2) })}
        </div>
        <div style="display:grid;gap:8px">
          <span class="eyebrow">${te(loc, "wall_kind")}</span>
          <div class="chips" role="radiogroup" aria-label=${te(loc, "wall_kind")}>
            ${WALL_KINDS.map(
              (kind) => html`<button class="chip" role="radio" aria-checked=${wall.kind === kind} aria-pressed=${wall.kind === kind}
                @click=${() => this._commit(setWallKind(this._plan, index, kind))}>${te(loc, `kind_${kind}`)}</button>`,
            )}
          </div>
        </div>
        <div class="kv-line">${te(loc, "wall_delete")}</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <button class="btn tonal" @click=${() => {
            const result = addDoor(this._plan, index, 0.5);
            this._commit(result.plan);
            this._selection = doorSelection(result.plan, result.index);
          }}>${icon(mdiDoor, 18)} ${te(loc, "add_door")}</button>
          ${pair
            ? html`<button class="btn tonal" data-action="merge-rooms" ?disabled=${Boolean(trouble)} aria-describedby="merge-note"
                @click=${(e: MouseEvent) => this._merge(pair[0], pair[1], e.detail === 0)}>${icon(mdiVectorUnion, 18)} ${te(loc, "merge_rooms")}</button>`
            : nothing}
        </div>
        ${trouble ? html`<div class="kv-line merge-trouble" id="merge-note">${trouble}</div>` : nothing}
        ${loses ? html`<div class="kv-line merge-loses" id="merge-note">${loses}</div>` : nothing}
      </div>`;
  }

  private _doorInspector(plan: Plan, index: number) {
    const loc = this.loc;
    const door = plan.doors[index];
    const wall = door ? plan.walls[door.wall] : undefined;
    if (!door || !wall) return nothing;
    const pair = wallEnds(plan, door.wall);
    const kinds: DoorKind[] = ["door", "opening"];
    return html`<div class="card-head"><h2 class="headline">${te(loc, "door")}</h2></div>
      <div class="section">
        ${pair ? html`<div class="kv-line">${te(loc, "wall_between", { a: this.roomName(pair[0]), b: this.roomName(pair[1]) })}</div>` : nothing}
        <div style="display:grid;gap:8px">
          <span class="eyebrow">${te(loc, "door_kind")}</span>
          <div class="segmented" role="radiogroup" aria-label=${te(loc, "door_kind")}>
            ${kinds.map(
              (kind) => html`<button role="radio" aria-checked=${door.kind === kind} @click=${() => this._doorEdit(updateDoor(this._plan, index, { kind }), index)}>
                ${te(loc, `kind_${kind}`)}
              </button>`,
            )}
          </div>
        </div>
        <label class="field">${te(loc, "width")}
          <input type="number" min="0.4" max="4" step="0.05" .value=${door.width.toFixed(2)}
            @change=${(e: Event) => {
              const value = Number((e.target as HTMLInputElement).value.replace(",", "."));
              if (Number.isFinite(value) && value >= 0.3) this._doorEdit(updateDoor(this._plan, index, { width: value }), index);
            }} />
        </label>
        <label class="field">${te(loc, "position")}
          <input type="range" min="0" max="1" step="0.01" .value=${String(door.at)}
            @input=${(e: Event) => this._doorEdit(updateDoor(this._plan, index, { at: Number((e.target as HTMLInputElement).value) }), index, `door-at:${index}`)} />
        </label>
        <div class="danger-row">
          <button class="btn outlined danger" @click=${() => {
            this._commit(removeDoor(this._plan, index));
            this._selection = null;
          }}>${icon(mdiDelete, 18)} ${te(loc, "delete_door")}</button>
        </div>
      </div>`;
  }

  private _bulbInspector(plan: Plan, ieee: string) {
    const loc = this.loc;
    const bulb = plan.bulbs.find((b) => b.ieee === ieee);
    if (!bulb) return nothing;
    const auto = roomAt(plan, [bulb.x, bulb.y]);
    return html`<div class="card-head">
        <span class="bulb-dot" style="color:var(--og-motion)">${icon(mdiLightbulb, 20)}</span>
        <h2 class="headline">${this.bulbName(ieee)}</h2>
      </div>
      <div class="section">
        <div class="kv-line">${ieee}<br />${te(loc, "position_xy", { x: fmtNumber(loc, bulb.x, 2, 2), y: fmtNumber(loc, bulb.y, 2, 2) })}</div>
        <div style="display:grid;gap:8px">
          <span class="eyebrow">${te(loc, "height")}</span>
          <div class="segmented" role="radiogroup" aria-label=${te(loc, "height")}>
            ${HEIGHTS.map(
              (height) => html`<button role="radio" aria-checked=${bulb.height === height} @click=${() => this._commit(updateBulb(this._plan, ieee, { height }))}>
                ${te(loc, `height_${height}`)}
              </button>`,
            )}
          </div>
        </div>
        <label class="field">${te(loc, "bulb_room")}
          <select @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            this._commit(updateBulb(this._plan, ieee, { room: value || null }));
          }}>
            <option value="" ?selected=${bulb.room === null}>
              ${auto ? te(loc, "bulb_room_auto", { room: this.roomName(auto) }) : te(loc, "bulb_room_auto_none")}
            </option>
            ${plan.rooms.map((r) => html`<option value=${r.id} ?selected=${bulb.room === r.id}>${r.name}</option>`)}
          </select>
        </label>
        ${bulb.room !== null
          ? html`<div class="pinned">
              <span class="kv-line">${icon(mdiPin, 18)} ${te(loc, "pinned_to", { room: this.roomName(bulb.room) })}</span>
              ${this._unpinButton(ieee)}
            </div>`
          : nothing}
        <div class="danger-row">
          <button class="btn outlined danger" @click=${() => {
            this._commit(removeBulb(this._plan, ieee));
            this._selection = null;
          }}>${icon(mdiDelete, 18)} ${te(loc, "remove_bulb")}</button>
        </div>
      </div>`;
  }

  private _unpinButton(ieee: string) {
    return html`<button class="btn tonal unpin" data-unpin=${ieee} @click=${() => this._commit(updateBulb(this._plan, ieee, { room: null }))}>
      ${icon(mdiPinOff, 18)} ${te(this.loc, "unpin")}
    </button>`;
  }

  private _unplacedCard() {
    const loc = this.loc;
    const unplaced = this._unplaced();
    return html`<section class="card" aria-labelledby="unplaced-h">
      <div class="card-head">
        <h2 class="headline" id="unplaced-h">${te(loc, "unplaced")}</h2>
        ${unplaced.length ? html`<span class="badge">${unplaced.length}</span>` : nothing}
      </div>
      ${unplaced.length
        ? html`<p class="small muted" style="padding:0 16px 8px">${te(loc, "unplaced_hint")}</p>
            <ul class="list">
              ${unplaced.map(
                (bulb) => html`<li>
                  <div
                    class="bulb-item"
                    role="button"
                    tabindex="0"
                    data-ieee=${bulb.ieee}
                    aria-pressed=${this._armed === bulb.ieee && this._tool === "bulb"}
                    @pointerdown=${(e: PointerEvent) => this._listDown(e, bulb.ieee)}
                    @pointermove=${this._listMove}
                    @pointerup=${this._listUp}
                    @pointercancel=${() => (this._listDrag = null)}
                    @keydown=${(e: KeyboardEvent) => this._listKey(e, bulb.ieee)}
                  >
                    <span class="bulb-dot">${icon(mdiLightbulb, 16)}</span>
                    <span>${bulb.name}${bulb.available ? nothing : html` <span class="badge">${te(loc, "offline")}</span>`}</span>
                    <span class="grip">${icon(mdiDragVertical, 20)}</span>
                  </div>
                </li>`,
              )}
            </ul>`
        : html`<p class="ok">${icon(mdiCheck, 18)}${te(loc, "unplaced_none")}</p>`}
    </section>`;
  }

  private _issuesCard(issues: Issue[]) {
    const loc = this.loc;
    const severity = { error: mdiAlertCircle, warning: mdiAlert, info: mdiInformation };
    return html`<section class="card" aria-labelledby="issues-h">
      <div class="card-head">
        <h2 class="headline" id="issues-h">${te(loc, "issues")}</h2>
        ${issues.filter((i) => i.severity !== "info").length
          ? html`<span class="badge warning">${issues.filter((i) => i.severity !== "info").length}</span>`
          : nothing}
      </div>
      ${issues.length
        ? html`<ul class="issues" aria-live="polite">
            ${issues.map(
              (issue) => html`<li class=${issue.severity}>
                <button @click=${() => {
                  const target = this._issueTarget(issue);
                  if (target) {
                    this._tool = "select";
                    this._selection = target;
                  } else if (issue.code === "no_rooms") {
                    this._setTool("rect");
                  }
                }}>${icon(severity[issue.severity], 18)}<span>${this._issueText(issue)}</span></button>
                ${issue.code === "bulb_pinned_elsewhere" && issue.bulb ? this._unpinButton(issue.bulb) : nothing}
              </li>`,
            )}
          </ul>`
        : html`<p class="ok">${icon(mdiCheck, 18)}${te(loc, "issues_none")}</p>`}
    </section>`;
  }

  private _importSheet() {
    const loc = this.loc;
    const result = this._importResult;
    const background = result?.background_image ? `data:${result.background_image.mime};base64,${result.background_image.data_base64}` : null;
    const asIs = result?.source === "outglow_plan";
    return html`<og-sheet
      wide
      .open=${this._importOpen}
      heading=${te(loc, "import_title")}
      close-label=${tc(loc, "close")}
      @closed=${() => (this._importOpen = false)}
    >
      <div class="import-body">
        <div class="row wrap">
          <span class="btn outlined neutral file">${icon(mdiFileUpload, 18)} ${te(loc, "choose_file")}
            <input type="file" aria-label=${te(loc, "choose_file")} @change=${this._readFile} />
          </span>
          <button class="btn outlined neutral" data-action="fetch-vacuum" ?disabled=${this._importBusy} @click=${() => void this._openRobots()}>
            ${icon(mdiRobotVacuum, 18)} ${te(loc, "fetch_vacuum")}
          </button>
        </div>
        ${this._robotPanel()}
        <textarea
          aria-label=${te(loc, "paste")}
          placeholder=${te(loc, "paste")}
          .value=${this._importText}
          @input=${(e: Event) => {
            this._importText = (e.target as HTMLTextAreaElement).value;
            this._importResult = null;
          }}
        ></textarea>
        ${this._plan.bulbs.length
          ? html`<label class="check">
              <input type="checkbox" data-field="keep-bulbs" ?disabled=${asIs} .checked=${this._importKeep && !asIs} @change=${(e: Event) => {
                this._importKeep = (e.target as HTMLInputElement).checked;
                this._importResult = null;
              }} />
              <span>${te(loc, asIs ? "keep_bulbs_plan" : "keep_bulbs")}</span>
            </label>`
          : nothing}
        ${this._importError ? html`<div class="notice error" role="alert">${icon(mdiAlertCircle, 20)}<span>${this._importError}</span></div>` : nothing}
        ${result
          ? html`<div class="kv-line" data-field="source">${te(loc, `source_${result.source}`)}</div>
              <div class="kv-line">${te(loc, "import_summary", { rooms: result.plan.rooms.length, bulbs: result.plan.bulbs.length, doors: result.plan.doors.length })}</div>
              ${result.kept ? html`<div class="kv-line" data-field="kept">${this._keptText()}</div>` : nothing}
              ${result.warnings.length
                ? html`<ul class="warnings">
                    ${result.warnings.map((w) => html`<li>${icon(mdiAlert, 18)}<span>${warningText(loc, w)}</span></li>`)}
                  </ul>`
                : nothing}
              <div class="import-preview">
                <outglow-plan-view .plan=${result.plan} .loc=${loc} .names=${this.names()} .dark=${this.dark} .background=${background}
                  .layers=${{ lines: false, trail: false, heat: false, bulbNames: true }} max-height="260px"></outglow-plan-view>
              </div>
              <div class="notice info">${icon(mdiInformation, 20)}<span>${te(loc, "import_replace")}</span></div>`
          : nothing}
      </div>
      <div slot="actions" class="row wrap" style="justify-content:flex-end;width:100%">
        <button class="btn" @click=${() => (this._importOpen = false)}>${tc(loc, "cancel")}</button>
        ${result
          ? html`<button class="btn filled" @click=${() => void this._useImport()}>${te(loc, "use_plan")}</button>`
          : html`<button class="btn filled" ?disabled=${!this._importText.trim() || this._importBusy} @click=${() => void this._runImport()}>
              ${this._importBusy ? te(loc, "previewing") : te(loc, "preview")}
            </button>`}
      </div>
    </og-sheet>`;
  }
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    return;
  }
}

if (!customElements.get("outglow-plan-editor")) {
  customElements.define("outglow-plan-editor", OutglowPlanEditor);
}
