// Every text the player sees, in one place (docs/text.md): names of things, prompts, notices, menus, hints and the
// character's speech. Code never writes player-facing words inline; it reads them from TEXT. Shared: the server's
// notices come from here too.
//
// Written in English for now. `Texts` is the shape a translation would fill in: plain strings, and functions where a
// text takes values (so each language can order the words its own way). Keep the voice of docs/text.md: terse
// labels, sentence case, no explanations; flavor text (descriptions, hints, speech) in plain, whole sentences.

/** "Water bottle" → "water bottle" in the middle of a sentence; names that start with an acronym ("AI control
 *  system", "UV lamp") keep their capitals. */
export const lower = (label: string) => (/^[A-Z]{2}/.test(label) ? label : label[0].toLowerCase() + label.slice(1));

const en = {
  game: {
    /** The game's name as it's shown in the menu and on the landing page (and, capitalised, the browser tab). */
    name: 'paahde',
    title: 'Paahde',
  },

  // ---- Names of things ----------------------------------------------------------------------------------------

  /** Part and gear quality, worst to best (shared/salvage.ts TIERS). */
  tiers: { scrap: 'Scrap', basic: 'Basic', quality: 'Quality', space: 'Space-grade' },
  /** Parts out of machines (shared/parts.ts). */
  parts: {
    battery: 'Battery', motor: 'Electric motor', heatsink: 'Heat sink', compute: 'Compute unit', uranium: 'Uranium cell',
    coil: 'Wiring coil', impeller: 'Impeller', bearing: 'Bearing', gear: 'Gear', valve: 'Valve', relay: 'Relay',
    fanrotor: 'Fan rotor', comprotor: 'Compressor rotor', turbinerotor: 'Turbine rotor',
    turbinedisc: 'Turbine disc', fuelmanifold: 'Fuel manifold',
  },
  /** A part as an item: "Quality battery". */
  partItem: (tier: string, part: string) => `${tier} ${lower(part)}`,
  /** A part taken out in the disassembly mode: "Battery · Quality". */
  partTaken: (part: string, tier: string) => `${part} · ${tier}`,
  /** Items (shared/items.ts ITEMS); parts are named by partItem, machines and wrecks by `machines`. */
  items: {
    canteen: 'Water bottle',
    spyglass: 'Telescope',
    motorcycle: 'Motorcycle',
    backpack: 'Backpack',
    storm_detector: 'Storm detector',
    wristpad: 'Wrist computer',
    shield: 'Shield plate',
    scrap: 'Scrap',
    cloth: 'Cloth',
    wiring: 'Wiring',
    wrench: 'Wrench',
    plant_bed: 'Plant bed',
    uv_lamp: 'UV lamp',
    windmill: 'Windmill',
    battery_station: 'Battery station',
    power_pole: 'Power pole',
    laser_rifle: 'Laser rifle',
    laser_pistol: 'Laser pistol',
    jammer: 'Jammer',
    grinder: 'Grinder',
    receiver_carrier: 'Hive receiver',
    receiver_queen: 'Brood receiver',
    receiver_colossus: 'Iron receiver',
    receiver_worm: 'Deep receiver',
    drone_transponder: 'Drone transponder',
    brood_gland: 'Brood gland',
    servo_heart: 'Walker servo',
    hive_core: 'Hive core',
    queen_eye: "Queen's eye",
    furnace_heart: 'Furnace heart',
  },
  /** Machines at the crash sites and salvage wrecks (shared/salvage.ts COMPONENTS, SALVAGE). */
  machines: {
    pump_housing: 'Pump housing',
    jet_engine: 'Jet engine',
    robot_arm: 'Robot arm joint',
    control_cabinet: 'Control cabinet',
    winch: 'Cargo winch',
    solenoid_valve: 'Coolant valve',
    beacon: 'Distress beacon',
    vehicle_frame: 'Broken vehicle frame',
    water_jet: 'Broken water jet',
    warp_core: 'Warp drive core',
    ai_control: 'AI control system',
  },
  bosses: { worm: 'Worm', carrier: 'Carrier', colossus: 'Colossus', queen: 'Queen' },
  /** Equipment slots (shared/gear.ts EQUIP_SLOTS). */
  equip: { back: 'Back', wrist: 'Wrist', belt: 'Belt', armor: 'Armor' },
  /** Boxes, as headings in the Tab overlay (shared/storage.ts boxLabel). */
  boxes: {
    bag: 'Inventory', equip: 'Equipment', bench: 'Workbench', cargo: 'Cargo', corpse: 'Left behind', chest: 'Chest',
    chestN: (n: number) => `Chest ${n}`,
    storage: 'Storage', ground: 'On the ground',
  },
  /** How each piece of gear is used, under its tooltip once it works (shared/gear.ts GEAR); `k` gives the current
   *  key or button names (src/bindings.ts hintKeys). */
  gearUse: {
    motorcycle: (k: HintKeys) => `Get on with ${k.interact}, off with ${k.bike}.`,
    spyglass: (k: HintKeys) => `Hold ${k.use} to look through it, and use ${k.zoom} to zoom.`,
    canteen: (k: HintKeys) => `Hold ${k.use} to drink. You can fill it up at any pump.`,
    backpack: () => 'Gives your bag more room past the hotbar.',
    storm_detector: () => 'Beeps before a sandstorm reaches you.',
    wristpad: () => 'Shows the time, the temperature and the locator bar.',
    laser_pistol: (k: HintKeys) => `Fire with ${k.use} and aim with ${k.aim}.`,
    laser_rifle: (k: HintKeys) => `Fire with ${k.use} and look through the scope with ${k.aim}.`,
    jammer: (k: HintKeys) => `Hold ${k.use} on a drone or jet until it comes down.`,
    shield: () => 'Takes killing blows for you, then breaks.',
    receiver: (k: HintKeys) => `Press ${k.use} to send the signal, and the needle points at whatever answers.`,
    windmill: () => 'Makes power when the wind blows.',
    battery_station: () => 'Keeps the power the windmills make.',
  },
  /** Where placing is blocked: "Too close to the pump". */
  baseSpots: { pump: 'the pump', chest: 'the chest', workbench: 'the workbench', table: 'the disassembly table', doorway: 'the doorway', base: 'the base' },

  // ---- Prompts under the crosshair (after the key) ---------------------------------------------------------------

  /** The pieces that come off a machine and lie on the ground, to be picked up and taken apart in the hands (src/teardown). */
  pieces: {
    fan: 'Fan rotor', compressor: 'Compressor rotor', combustor: 'Combustor', turbine: 'Turbine', nozzle: 'Exhaust nozzle',
    starter: 'Starter', generator: 'Generator', pma: 'Alternator', hydpump: 'Hydraulic pump', fuelpump: 'Fuel pump',
    oilpump: 'Oil pump', fadec: 'Engine computer', oilcooler: 'Oil cooler',
  } as Record<string, string>,

  prompt: {
    putDown: 'Put it down',
    pickUp: (what: string) => `Pick up ${lower(what)}`,
    /** A find with parts missing: "Pick up broken telescope (1/2 parts)". */
    pickUpBroken: (what: string, have: number, n: number) => `Pick up broken ${lower(what)} (${have}/${n} parts)`,
    disassemble: (what: string) => `Disassemble ${lower(what)}`,
    putOnTable: (what: string) => `Place ${lower(what)}`,
    place: (what: string) => `Place ${lower(what)}`,
    turn: 'Turn',
    useWorkbench: 'Use workbench',
    useTable: 'Use table',
    openPack: 'Open pack',
    openChest: 'Open chest',
    open: (what: string) => `Open ${lower(what)}`,
    /** A broken vehicle lying in the world (shared/vehicles.ts): F opens its part slots. */
    repair: (what: string) => `Repair ${lower(what)}`,
    /** A working one: F gets on. */
    getOn: 'Get on',
    plantSeeds: 'Plant seeds',
    harvest: 'Harvest',
    needsUvLamp: 'Needs UV lamp',
    fill: 'Fill',
    throw: 'Throw',
    broken: 'Broken',
    empty: 'Empty',
    aimAtFloor: 'Aim at the floor',
    aimAtGround: 'Aim at the ground',
    /** Putting up a building with the wrench (src/placing.ts): "Build windmill"; the build menu (src/buildMenu.ts). */
    build: (what: string) => `Build ${lower(what)}`,
    buildMenu: 'Build',
    /** Taking a building down with the wrench: its materials and parts come back. */
    dismantle: (what: string) => `Dismantle ${lower(what)}`,
    /** Stringing a wire with wiring in hand (shared/wires.ts). */
    connect: 'Connect',
    takeDown: 'Take down',
    cancel: 'Cancel',
  },

  // ---- Short notices (toasts), from the client or sent by the server ---------------------------------------------

  notice: {
    /** Picked up: "+1 Scrap". */
    got: (n: number, what: string) => `+${n} ${what}`,
    bagFull: 'Bag full',
    noRoom: 'No room',
    alreadyHad: 'Already had one',
    cantDropHere: "Can't drop here",
    tooFar: 'Too far',
    unknownRecipe: 'Unknown recipe',
    missingParts: 'Missing parts',
    /** Building: not enough base materials in the bag. */
    missingMaterials: 'Missing materials',
    /** A power line this long takes `n` wiring (shared/wires.ts wireCost). */
    needWiring: (n: number) => `Needs ${n} wiring`,
    cantPlace: "That can't be placed",
    badSpot: 'Bad spot',
    floorOnly: 'Floor only',
    outsideOnly: 'Outside only',
    tooFarFromBase: 'Too far from the base',
    tooSteep: 'Too steep',
    tooClose: (spot: string) => `Too close to ${spot}`,
    /** Too close to another building: "Too close to the windmill". */
    tooCloseTo: (what: string) => `Too close to the ${lower(what)}`,
    outOfReach: 'Out of reach',
    tooManyWires: 'No room for more wires',
    cantConnect: "Can't connect that",
    baseFull: 'The base is full',
    lineUp: (what: 'bed' | 'lamp') => `Line it up with the ${what}`,
    inTheWay: 'Something is in the way',
    blocked: 'Blocked',
    alreadyGone: 'Already gone',
    nothingToTakeApart: 'Nothing to take apart',
    broken: 'Broken',
    empty: 'Empty',
    full: 'Full',
    cantPackTighter: "Can't pack it any tighter",
    takeItOff: 'Take it off',
    getOffFirst: 'Get off first',
    /** Someone else is on (or getting on) that vehicle. */
    someoneOnIt: 'Someone is on it',
    emptyItFirst: 'Empty it first',
    /** A part out of a working vehicle: only swapped for another. */
    swapOnly: 'Swap it for another',
    wrongSlot: 'Wrong slot',
    cantWear: "Can't wear",
    benchInUse: 'Bench in use',
    gearOnly: 'Gear only',
    partDoesntGo: "That part doesn't go there",
    doesntFit: "Doesn't fit there",
    taken: 'Taken',
    failed: 'Failed',
  },

  // ---- Tab overlay: bag, boxes, workbench --------------------------------------------------------------------------

  inventory: {
    drop: 'Drop',
    sort: 'Sort',
    sortTip: 'Packs everything tight, biggest first. The hotbar stays put.',
    storeAll: 'Store all',
    takeAll: 'Take all',
    noBackpack: 'No backpack',
    nothingInReach: 'Nothing in reach',
    noRoom: 'No room',
    craft: 'Craft',
    /** Stands a broken vehicle up once its part slots are all filled (shared/vehicles.ts). */
    repair: 'Repair',
    brokenGear: 'Broken gear',
    broken: 'Broken',
    missing: 'missing',
    works: (quality: string) => `Works · ${quality}`,
    needs: (slots: string[]) => `Needs ${slots.join(', ')}`,
    needsA: (slot: string) => `Needs ${/^[aeiou]/i.test(slot) ? 'an' : 'a'} ${lower(slot)}`,
    hotbarBroken: (what: string) => `${what} (broken)`,
    /** The controls under the overlay (src/inventory.ts), after their keys or buttons. */
    move: 'Move',
    sendAcross: 'Send across',
    half: 'Half',
    close: 'Close',
  },

  // ---- HUD ---------------------------------------------------------------------------------------------------------

  hud: {
    heat: 'Heat',
    heatTip: 'Heat: collapse at 100%',
    timeOfDay: 'Time of day',
    feltTemp: 'Felt temperature',
    shade: 'Shade',
    inShade: 'In shade',
    sun: 'Sun',
    sandstorm: '⚠ Sandstorm',
    stormFront: '⚠ Storm front',
    death: 'The desert won this one',
  },
  /** A death in chat, after the dead player's name (shared/protocol.ts DeathCause). */
  obituary: {
    heat: 'died of the heat',
    guardian: 'stepped on by a guardian',
    laser: 'shot down',
    missile: 'blown up',
    crawler: 'bitten to death',
    worm: 'eaten by the worm',
    stomp: 'crushed by the colossus',
    bomb: 'bombed by the carrier',
    queen: 'killed by the queen',
    harvester: 'ground into the sand by a harvester',
    storm: 'choked in the storm front',
    gas: 'choked on the poison gas',
  },

  // ---- Esc menu, controls, landing page, name ----------------------------------------------------------------------

  menu: {
    resume: 'Resume',
    settings: 'Settings',
    options: 'Options',
    gameplay: 'Gameplay',
    audio: 'Audio',
    graphics: 'Graphics',
    graphicsPreset: 'Quality preset',
    automatic: 'Auto',
    custom: 'Custom',
    goWindowed: 'Go windowed',
    goFullscreen: 'Go fullscreen',
    /** Under Go fullscreen after Ctrl+W made the browser ask before closing the tab (src/menu.ts). */
    ctrlWNote: 'Ctrl+W is the browser shortcut for closing the tab. Fullscreen turns it off.',
    /** The same box after Esc failed again and again to get back in while windowed (src/menu.ts). */
    escNote: 'In a window the browser gives the mouse back only on a click: click Resume. In fullscreen Esc works.',
    mainMenu: 'Main menu',
    display: 'Display',
    fullscreen: 'Fullscreen',
    windowed: 'Windowed',
    fpsTarget: 'FPS target',
    unlimited: 'Unlimited',
    resolution: 'Resolution',
    dynamicRes: 'Adaptive resolution',
    minRes: 'Lowest resolution',
    shadows: 'Sun shadows',
    shadowDistance: 'Shadow distance',
    shadowQuality: 'Shadow quality',
    shadowRefresh: 'Shadow refresh',
    shadowRefreshes: ['Always', 'Some', 'Rarely'],
    antialias: 'Anti-aliasing',
    sandDetail: 'Sand detail',
    shadowQualities: ['Low', 'Medium', 'High', 'Ultra'],
    tips: {
      graphicsPreset: 'Low runs fastest; Ultra adds the most detail. Auto adjusts to your processor and graphics performance as you play.',
      display: 'Fullscreen goes fullscreen when you click into the game. Windowed never does.',
      fpsTarget: 'The most frames drawn each second. Lower saves power and heat. Unlimited follows your screen.',
      resolution: 'Draws the game at a lower resolution and stretches it to the window. Lower runs faster on weak PCs.',
      dynamicRes: 'Lowers the resolution when the game runs slower than the FPS target, and raises it again when it can. Unlimited aims at 60.',
      minRes: 'Adaptive resolution will not go below this. Lower it if the game still misses the FPS target.',
      occlusion: 'Darkens creases and corners. Off is faster.',
      shadows: 'The sun and moon shadows over the whole world. Off is much faster.',
      shadowDistance: 'How far from you the sun casts shadows. Shorter is faster.',
      shadowQuality: 'Sharpness and softness of the sun shadows. Lower is faster. Needs a reload.',
      shadowRefresh: 'How often far shadows are redrawn. Less often is faster and easier on the processor, but far shadows lag behind.',
      sandDetail: 'How far out the small ripples in the sand are drawn. Lower is a little faster.',
      antialias: 'Smooths jagged edges. Off is faster. Needs a reload.',
      interfaceSize: 'Size of the menus and the inventory.',
    },
    needsReload: 'Click to reload and apply',
    volume: 'Volume',
    music: 'Music',
    occlusion: 'Occlusion',
    showStats: 'Show stats',
    interfaceSize: 'Interface size',
    showGuides: 'Disassembly guides',
    showCounts: 'Steps and parts left',
    copyInvite: 'Copy invite link',
    copied: 'Copied',
    /** The game's bubble over the Esc menu: hover tips of its marks (lives, bosses, players, code, invite). */
    server: {
      lives: (n: number) => (n === 1 ? '1 shared life left' : `${n} shared lives left`),
      bosses: (n: number, of: number) => `${n} of ${of} bosses beaten`,
      code: 'Game code · click to copy',
      uptime: 'Server uptime',
      /** Your time in this game, short by the hourglass; exact on hover. */
      played: (min: number) => (min < 60 ? `${min} min` : min < 1440 ? `${Math.floor(min / 60)} h` : min < 2880 ? '1 day' : `${Math.floor(min / 1440)} days`),
      playedTip: (min: number) => `Time played on this server: ${Math.floor(min / 60)} h ${min % 60} min`,
    },
    controls: 'Controls',
    minigame: 'Play minigame',
    leave: 'Leave',
    credits: 'credits',
  },
  controls: {
    back: 'Back',
    how: 'Click a key, then press the new one',
    reset: 'Reset controls',
    fixed: 'Esc: menu · cancel (fixed)',
    listening: 'press a key or button · Esc cancels · Backspace clears',
    needsKey: 'needs a key',
    onlyKey: (key: string, action: string) => `${key} is ${action}'s only key`,
    takenFrom: (key: string, action: string) => `${key} taken from ${action}`,
    /** Action names (src/bindings.ts ACTIONS). */
    actions: {
      forward: 'forward', back: 'back', left: 'left', right: 'right', jump: 'jump', sprint: 'slide · hold breath',
      crouch: 'crouch', use: 'use · throw', aim: 'aim', spyglass: 'telescope', interact: 'pick up · interact',
      bike: 'motorcycle', slot1: 'hotbar 1', slot2: 'hotbar 2', slot3: 'hotbar 3', slot4: 'hotbar 4', slot5: 'hotbar 5',
      inventory: 'inventory', thirdPerson: 'third person', freeLook: 'look around', rotate: 'rotate',
      pickPlaced: 'pick up placed', chat: 'chat', debug: 'debug panel',
    },
    /** Key names where the keyboard layout doesn't give one. */
    keys: {
      Space: 'Space', ShiftLeft: 'Shift', ControlLeft: 'Ctrl', AltLeft: 'Alt', Tab: 'Tab', CapsLock: 'Caps',
      ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backspace: 'Bksp',
      Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB',
    } as Record<string, string>,
    noKey: '—',
    /** The wheel, in hints (src/bindings.ts promptKey 'zoom'). */
    wheel: 'Wheel',
    /** Shift-click in hints: modifier and button. */
    combo: (mod: string, key: string) => `${mod}+${key}`,
    /** Names for keys and buttons inside a sentence (hints, gear use): "Hold the left mouse button to drink." */
    spoken: {
      mouse: { Mouse0: 'the left mouse button', Mouse1: 'the middle mouse button', Mouse2: 'the right mouse button' } as Record<string, string>,
      wheel: 'the mouse wheel',
      dpad: 'the d-pad',
    },
    /** Gamepad button names (src/padMap.ts), by the pad's make. */
    pad: {
      xbox: {
        a: 'A', b: 'B', x: 'X', y: 'Y', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', ls: 'LS', rs: 'RS', view: 'View', menu: 'Menu',
        up: '▲', down: '▼', left: '◀', right: '▶', stickL: 'L stick', stickR: 'R stick',
      },
      playstation: {
        a: '✕', b: '○', x: '□', y: '△', lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', ls: 'L3', rs: 'R3', view: 'Share', menu: 'Options',
        up: '▲', down: '▼', left: '◀', right: '▶', stickL: 'L stick', stickR: 'R stick',
      },
    },
    mouse: (n: number) => `Mouse ${n}`,
    numpad: (key: string) => `Num ${key}`,
  },
  landing: {
    start: 'Start a new game',
    gameOver: 'Game over',
    noSuchWorld: 'No such world',
    join: 'Join',
    /** A game's code (the id in its link), on a button that copies it (the lobby, the Esc menu). */
    codeOf: (code: string) => `Game code · ${code}`,
    won: 'The desert is yours',
    playOn: 'Play on',
    /** The worlds this browser joined, newest first, with how each is doing. */
    recent: 'Your games',
    online: (n: number) => `${n} online`,
    /** Everyone who has ever joined the game. */
    players: (n: number) => (n === 1 ? '1 has played' : `${n} have played`),
    ago: (min: number) =>
      min < 2 ? 'just now' : min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`,
    /** Your name in one of your games and how long you've played there. */
    you: (name: string, min: number) => {
      const t = min < 60 ? `${min} min` : `${(min / 60).toFixed(min < 600 ? 1 : 0)} h`;
      return name ? `${name} · ${t} played` : `${t} played`;
    },
    lives: (n: number) => `♥ ${n}`,
    /** Online now out of the most allowed. */
    seats: (online: number, max: number) => `${online}/${max}`,
    /** How long a game has been going (by the clock icon). */
    uptime: (min: number) => (min < 60 ? `${min} min` : min < 1440 ? `${Math.floor(min / 60)} h` : `${Math.floor(min / 1440)} d`),
    /** Hover tips on the icons. */
    tipUptime: 'Running for',
    tipSeats: 'Online now / max',
    tipLocked: 'Needs a password',
    /** Marks a game with a password. */
    lockedMark: '🔒',
    /** The public games (the browser). */
    browse: 'Public games',
    noGames: 'No public games right now',
    noMine: 'No games yet',
    /** Ordering the public games. */
    sortBy: { online: 'Players', name: 'Name', lives: 'Lives' },
    refresh: 'Refresh',
    /** Joining a game by its code (the id in its link). */
    code: 'Game code',
    yourName: 'Your name',
    colour: 'Colour',
    randomColour: '🎲',
    /** Why a name won't do (shared/names.ts). */
    nameWhy: { short: 'Too short', long: 'Too long', chars: 'Letters, numbers and simple punctuation only', banned: 'Pick another name' },
    /** Making a game. */
    gameName: 'Game name',
    public: 'Public',
    private: 'Private',
    maxPlayers: 'Max players',
    passwordOptional: 'Password (optional)',
    password: 'Password',
    create: 'Create',
    back: 'Back',
    menu: 'Main menu',
    busy: 'Try again in a minute',
    failed: 'Couldn’t reach the server',
    /** Turned away from a game. */
    wrongPassword: 'Wrong password',
    full: 'Game is full',
  },
  /** The loading cover's prologue (src/prologueRunner.ts): paragraphs, then the game's title over the time. */
  prologue: {
    lines: [
      'One day the rain stopped, and the cities sent their machines out into the sand to look for water.',
      'The cities are gone now, and the datacenters came falling down from orbit. The machines are still out there searching, and they kill anything that moves.',
      'A handful of scavengers are left. All they have is the burning sand, each other, and a hard fight to see another day.',
      'That, and whatever the glittering age left buried out there.',
    ],
    time: 'Forty-one years after the last rain',
  },

  // ---- The teardown minigame (src/minigameMenu.ts, src/loadingRunner.ts) ---------------------------------------------

  minigame: {
    title: 'Teardown',
    machines: (n: number) => `${n} machines`,
    endless: 'Endless',
    yourBest: 'your best',
    start: 'Start',
    back: 'Back',
    again: 'Again',
    finish: 'Finish',
    submit: 'Submit',
    machinesLabel: 'machines',
    timeLabel: 'time',
    offline: 'offline',
    nobody: 'nobody yet',
    rank: (n: number) => `you are #${n}`,
    unreachable: 'couldn’t reach the board',
    tip: 'Tip',
    hideTips: 'Hide tips',
    showTips: 'Show tips',
    /** Under the machine while that kind of step can be worked, until you've done it a few times. */
    hint: {
      screw: 'Click it, again and again',
      bolt: 'Circle the pointer to spin it',
      wire: 'Shake it loose at both ends',
      pry: 'Grab the tab and pull',
      part: 'Take the glowing part',
    },
  },

  // ---- Disassembly mode (src/teardown) -----------------------------------------------------------------------------

  teardown: {
    scrap: 'Scrap',
    scrapSure: 'Scrap it?',
    steps: 'steps',
    parts: 'parts',
    left: (steps: number, parts: number) => `${steps} ${steps === 1 ? 'step' : 'steps'} · ${parts} ${parts === 1 ? 'part' : 'parts'}`,
    scrapFrame: 'mash to scrap',
    shared: '· shared',
    otherSide: (n: number) => `${n} on another side`,
    after: (steps: string) => `after ${steps}`,
    circle: 'circle',
    shake: 'shake',
    pry: 'pry',
    mash: 'mash',
    grind: 'grind the seam',
    needGrinder: 'needs a grinder',
    hold: 'hold',
  },
  /** What holds a machine together: the steps in the disassembly mode (src/teardown/junk.ts, wrecks.ts). */
  steps: {
    antennaFeed: 'Antenna feed', axleNut: 'Axle nut', batteryStrap: 'Battery strap',
    bearingCapBolt: 'Bearing cap bolt', bearingCapScrew: 'Bearing cap screw', bearingClip: 'Bearing clip',
    bearingRetainer: 'Bearing retainer', boardStandoff: 'Board standoff', brakeFeed: 'Brake feed',
    cageClamp: 'Cage clamp', caliperBolt: 'Caliper bolt', cardLatch: 'Card latch', cellStrap: 'Cell strap',
    chokeBolt: 'Choke bolt', chokeClip: 'Choke clip', clampRingBolt: 'Clamp ring bolt', coilBolt: 'Coil bolt',
    coilLead: 'Coil lead', connectorRing: 'Connector ring', contactor1Out: 'Contactor 1 out',
    contactor2Out: 'Contactor 2 out', coolantClamp: 'Coolant clamp', coolantLine: 'Coolant line',
    coolantPipe: 'Coolant pipe', coverBolt: 'Cover bolt', doorSeam: 'Door seam', drainPlug: 'Drain plug',
    drumGearNut: 'Drum gear nut', ecuStandoff: 'ECU standoff', encoderCable: 'Encoder cable',
    faceplateScrew: 'Faceplate screw', fieldVent: 'Field vent', flangeBolt: 'Flange bolt', gearClip: 'Gear clip',
    gearRetainingBolt: 'Gear retaining bolt', gearboxScrew: 'Gearbox screw', grateScrew: 'Grate screw',
    guardLatch: 'Guard latch', heatSinkBolt: 'Heat sink bolt', hubNut: 'Hub nut', hubSetScrew: 'Hub set screw',
    igniterBolt: 'Igniter bolt', igniterLead: 'Igniter lead', impellerNut: 'Impeller nut',
    junctionBoxScrew: 'Junction box screw', lidScrew: 'Lid screw', lidSeam: 'Lid seam',
    liftTheCasingOff: 'Lift the casing off', liftTheMotorOff: 'Lift the motor off', liveIn: 'Live in',
    liveToMotor: 'Live to motor', mainsCable: 'Mains cable', mastFootBolt: 'Mast foot bolt',
    motorFlangeBolt: 'Motor flange bolt', motorFootBolt: 'Motor foot bolt', motorMountBolt: 'Motor mount bolt',
    motorPowerCable: 'Motor power cable', neutral: 'Neutral', phaseLead: 'Phase lead', pinionClip: 'Pinion clip',
    pumpBracket: 'Pump bracket', rackBolt: 'Rack bolt', railClip: 'Rail clip', rearLatch: 'Rear latch',
    relayFeed: 'Relay feed', seatBolt: 'Seat bolt', seatClip: 'Seat clip', seatScrew: 'Seat screw',
    shaftCoupling: 'Shaft coupling', shroudScrew: 'Shroud screw', solenoidBolt: 'Solenoid bolt',
    solenoidLead: 'Solenoid lead', splitLineBolt: 'Split-line bolt', springClip: 'Spring clip',
    starterFlangeBolt: 'Starter flange bolt', starterLead: 'Starter lead', topCoverBolt: 'Top cover bolt',
    transformerBolt: 'Transformer bolt', transformerSecondary: 'Transformer secondary', unionNut: 'Union nut',
    valveFlangeBolt: 'Valve flange bolt',
    // The turbofan (shared/machines/turbofan.ts)
    connectorLatch: 'Connector latch', coolerBolt: 'Cooler bolt', coreLift: 'Pull the stage out',
    cowlLatch: 'Cowl latch', fanBolt: 'Fan bolt', fanLift: 'Pull the fan out', harness: 'Harness', hingePin: 'Hinge pin',
    hoseFitting: 'Hose fitting', linkagePin: 'Linkage pin', mountScrew: 'Mount screw', nozzleBolt: 'Nozzle bolt',
    nozzleLift: 'Pull the nozzle off', padBolt: 'Pad bolt', padScrew: 'Pad screw', spinnerBolt: 'Spinner bolt',
    strapClip: 'Strap clip', vClamp: 'V-clamp', seam: 'Seam', pryOpen: 'Pry open', inletBolt: 'Inlet bolt', retainerBolt: 'Retainer bolt', plugBolt: 'Plug bolt',
    endBellScrew: 'End cap screw', manifoldClamp: 'Manifold clamp', coverScrew: 'Cover screw',
  },

  // ---- One-time how-to banners (src/hints.ts); `k` gives the current key names --------------------------------------

  hints: {
    motorcycle: (k: HintKeys) => `Get on with ${k.interact}, off with ${k.bike}. The back holds cargo.`,
    backpack: (k: HintKeys) => `Put the backpack in the Back slot (${k.inventory}).`,
    storm_detector: (k: HintKeys) => `Put the storm detector in the Belt slot (${k.inventory}). It beeps before a storm hits.`,
    wristpad: (k: HintKeys) => `Put the wrist computer in the Wrist slot (${k.inventory}).`,
    shield: (k: HintKeys) => `Put the shield plate in the Armor slot (${k.inventory}). It takes one killing blow for you.`,
    canteen: (k: HintKeys) => `With the water bottle on the hotbar, hold ${k.use} to drink. Fill it up at a pump.`,
    spyglass: (k: HintKeys) => `With the telescope on the hotbar, hold ${k.use} to look and use ${k.zoom} to zoom.`,
    laser_pistol: (k: HintKeys) => `With the pistol on the hotbar, fire with ${k.use} and aim with ${k.aim}.`,
    laser_rifle: (k: HintKeys) => `With the rifle on the hotbar, fire with ${k.use} and look through the scope with ${k.aim}.`,
    jammer: (k: HintKeys) => `With the jammer on the hotbar, hold ${k.use} on a drone or jet until it comes down.`,
    receiver_carrier: (k: HintKeys) => `With the receiver on the hotbar, press ${k.use} to send the signal.`,
    receiver_queen: (k: HintKeys) => `With the receiver on the hotbar, press ${k.use} to send the signal.`,
    receiver_colossus: (k: HintKeys) => `With the receiver on the hotbar, press ${k.use} to send the signal.`,
    receiver_worm: (k: HintKeys) => `With the receiver on the hotbar, press ${k.use} to send the signal.`,
    plant_bed: (k: HintKeys) => `With the plant bed on the hotbar, press ${k.use} to put it down in the bunker.`,
    uv_lamp: () => 'Put the UV lamp down over a plant bed.',
    wrench: (k: HintKeys) => `With the wrench on the hotbar, press ${k.aim} to build.`,
    part: () => 'Parts repair gear at the workbench.',
    broken: () => "It's broken. You can repair it at the workbench in the base.",
    machine: () => 'Take it apart at the disassembly table in the base.',
  } as Record<string, (k: HintKeys) => string>,

  // ---- The character talking to themselves (src/speechLines.ts, docs/speech.md); a list: one picked at random -------

  speech: {
    bottleDay: ["A water bottle! That could get me through this heat.", 'Oh, thank god. Something to carry water in.'],
    bottleNight: ["A water bottle. I'll be glad of that when the sun comes up.", "I'd better grab that before the day comes."],
    machine: "This thing's full of good parts. Let's crack it open.",
    machineCarry: "It's too fiddly to strip out here. I'll haul it home.",
    /** The first time each kind is in the bag: broken, then working. */
    got: {
      canteen: ["It's cracked, but I can patch it up.", "Water I can carry around. I'm never letting go of this."],
      motorcycle: ["A bike! It's dead, but it's a bike.", 'Wheels, finally. My feet can take the day off.'],
      spyglass: ["The lens is cracked. Shame, I could've seen for miles with this.", 'Now I can see trouble before it sees me.'],
      backpack: ["It's torn, but it still beats stuffing my pockets.", 'More room to carry junk. My back is going to hate me.'],
      storm_detector: ["This would hear the storms coming, if it worked.", 'If this thing starts beeping, I run.'],
      wristpad: ["A wrist computer, and it's as dead as everything else out here.", 'Now I always know the time, the heat, and where everyone went.'],
      shield: ["A plate to hide behind. It's bent to hell, though.", 'Something between me and a really bad day.'],
      laser_rifle: ['A rifle! Once it works, those walkers had better watch out.', 'Now I can finally shoot back at those walkers.'],
      laser_pistol: ["A pistol. It's broken, but it's a pistol.", "It's small, but it bites."],
      jammer: ['Some kind of jammer. Maybe for the things in the sky?', "Let's bring those flying bastards down to my level."],
      receiver: ['Some kind of radio. I wonder who it calls.', "Whatever answers this won't be small."],
    } as Record<string, [broken: string, working: string]>,
    gotBroken: "It's broken, but the right parts might fix it.",
    gotScrap: 'Scrap. Everything out here is made of the stuff.',
    gotCloth: "A bit of cloth. That'll do for patching things up.",
    gotSpacePart: "Now that's no ordinary part.",
    gotPart: 'A good part. Something broken back home could use this.',
    gotPlantBed: 'A garden in a bunker. Sure, why not.',
    gotUvLamp: "Sunlight for underground. There's a joke in there somewhere.",
    gotRelic: "It's still warm. Something out there is going to want this back.",
    ride: 'Wind in my face and sand in my teeth. I love it.',
    pump: ['There we go.', "Clean water. Well, it's wet, anyway."],
    pumpNothing: 'All this water and nothing to carry it in. Great.',
    hot: ["It's too hot. I need some shade.", "Damn, I'm cooking out here.", "I need shade, and I need it now."],
    sip: ['Time for a sip.', 'My throat feels like sandpaper.'],
    dry: ["The bottle's empty. I need to find a pump.", 'Not a single drop left. Shit.'],
    shelter: "Somebody dug in here once. It's nice and cool.",
    /** First time out on a mud flat (shared/biomes.ts), by day and by night. */
    mudflatDay: 'A dried-up lake. The ground is even hotter than the air.',
    mudflatNight: "A dried-up lake. I wouldn't want to cross this by day.",
    stormWarning: "That beeping can't be good. I'd better get under a roof.",
    storm: ["Damn it, I can't see a thing!", "There's sand in my everything."],
    stormFront: ["That's a wall of sand. I need rock between me and it.", 'Oh hell, here it comes. I need a cliff or a bunker, right now.'],
    choking: ["Shit, I can't breathe out here!", 'I have to get out of this wind!'],
    lee: 'The rock is taking the worst of it.',
    /** Poison gas (shared/gas.ts) creeping in at night: out in the open, in a bunker (it fills them), and in it. */
    gasComing: ["Something's creeping in along the ground. I want to be up high.", 'What is that stink? Better find some high ground.'],
    gasIndoors: "Something's seeping in down here. I have to get out and up.",
    gassed: ["Shit, I can't breathe this! Up, get up!", 'My eyes are burning. Higher, I need to get higher!'],
    boss: 'Oh no. Oh, shit.',
    /** Something turning on us (src/guardians.ts Aggro), by kind: a walker hunting us, a drone's light locked on, a
     *  harvester charging at us. */
    aggro: {
      guardian: ["Shit, the big one's seen me. Keep moving!", "Oh hell, that giant's coming for me. Don't stand still."],
      crawler: ['Shit, spiders! Get away from them!', "They're faster than me. I have to get clear of this place."],
      drone: ["Shit, I'm in the light! Get out of it!", "It's got me in its beam. Out of the light, now!"],
      harvester: ["It's coming straight at me! Get out of its way!", "Oh shit, it's charging. Sideways, sideways!"],
    },
    /** Something we shot or jammed going down, by kind (every boss alike). */
    killed: {
      guardian: ["Down it goes. Let's see what it was carrying.", "Big one down. Now it's just a pile of parts."],
      crawler: ['Stay down, bug.', 'One less spider. Plenty more where that came from.'],
      drone: ['Got it. Lights out.', "That one's done spotting for anyone."],
      jet: ['Got it! There might be something good in that wreck.', "Down it goes. Whatever's left is mine."],
      harvester: ["It's dead. I think. Let's see what it ate.", "That's it stopped. Time to see what's inside."],
      boss: ["Is it dead? It's dead. I can't believe that worked.", "That's one monster I won't see again."],
    },
    night: "Finally, it's cooling down.",
    bagFull: ["I'm out of room. Something has to go.", "My pockets aren't bottomless."],
    respawn: ["Note to self: don't do that again.", 'Ow. Where was I?', 'Well, that hurt like hell.'],
  },
};

/** Key or button names a hint can mention, as currently bound and for the device in use (src/bindings.ts hintKeys). */
export type HintKeys = { inventory: string; interact: string; bike: string; use: string; aim: string; zoom: string };

/** The shape of the texts: what a translation fills in. */
export type Texts = typeof en;

export const TEXT: Texts = en;
