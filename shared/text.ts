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
    plant_bed: 'Plant bed',
    uv_lamp: 'UV lamp',
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
  equip: { back: 'Back', wrist: 'Wrist', belt: 'Belt', vehicle: 'Vehicle', armor: 'Armor' },
  /** Boxes, as headings in the Tab overlay (shared/storage.ts boxLabel). */
  boxes: {
    bag: 'Inventory', equip: 'Equipment', bench: 'Workbench', bike: 'Motorcycle', corpse: 'Left behind', chest: 'Chest',
    chestN: (n: number) => `Chest ${n}`,
    storage: 'Storage',
  },
  /** How each piece of gear is used, under its tooltip once it works (shared/gear.ts GEAR). */
  gearUse: {
    motorcycle: 'The motorcycle key gets you on and off.',
    spyglass: 'Hold the mouse button to look through it, and use the wheel to zoom.',
    canteen: 'Hold the mouse button to drink. You can fill it up at any pump.',
    backpack: 'Gives your bag more room past the hotbar.',
    storm_detector: 'Beeps before a sandstorm reaches you.',
    wristpad: 'Shows the time, the temperature and the locator bar.',
    laser_pistol: 'Left mouse fires, right mouse aims.',
    laser_rifle: 'Left mouse fires, right mouse looks through the scope.',
    jammer: 'Hold the mouse button on a drone or jet until it comes down.',
    shield: 'Takes one killing blow for you, then breaks.',
    receiver: 'Left mouse sends the signal, and the needle points at whatever answers.',
  },
  /** Where placing is blocked: "Too close to the pump". */
  baseSpots: { pump: 'the pump', chest: 'the chest', workbench: 'the workbench', table: 'the disassembly table', doorway: 'the doorway' },

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
    plantSeeds: 'Plant seeds',
    harvest: 'Harvest',
    needsUvLamp: 'Needs UV lamp',
    fill: 'Fill',
    throw: 'Throw',
    broken: 'Broken',
    empty: 'Empty',
    aimAtFloor: 'Aim at the floor',
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
    cantPlace: "That can't be placed",
    badSpot: 'Bad spot',
    floorOnly: 'Floor only',
    tooClose: (spot: string) => `Too close to ${spot}`,
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
    emptyItFirst: 'Empty it first',
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
    brokenGear: 'Broken gear',
    broken: 'Broken',
    missing: 'missing',
    works: (quality: string) => `Works · ${quality}`,
    needs: (slots: string[]) => `Needs ${slots.join(', ')}`,
    needsA: (slot: string) => `Needs ${/^[aeiou]/i.test(slot) ? 'an' : 'a'} ${lower(slot)}`,
    hotbarBroken: (what: string) => `${what} (broken)`,
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
  },

  // ---- Esc menu, controls, landing page, name ----------------------------------------------------------------------

  menu: {
    resume: 'Resume',
    settings: 'Settings',
    options: 'Options',
    gameplay: 'Gameplay',
    audio: 'Audio',
    graphics: 'Graphics',
    goWindowed: 'Go windowed',
    goFullscreen: 'Go fullscreen',
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
    cascades: 'Shadow cascades',
    shadowDetail: 'Shadow detail',
    shadowFilter: 'Shadow filter',
    shadowRefresh: 'Shadow refresh',
    shadowRefreshes: ['Always', 'Some', 'Rarely'],
    antialias: 'Anti-aliasing',
    shadowDetails: ['Low', 'Medium', 'High'],
    tips: {
      display: 'Fullscreen goes fullscreen when you click into the game. Windowed never does.',
      fpsTarget: 'The most frames drawn each second. Lower saves power and heat. Unlimited follows your screen.',
      resolution: 'Draws the game at a lower resolution and stretches it to the window. Lower runs faster on weak PCs.',
      dynamicRes: 'Lowers the resolution when the game runs slower than the FPS target, and raises it again when it can. Unlimited aims at 60.',
      minRes: 'Adaptive resolution will not go below this. Lower it if the game still misses the FPS target.',
      occlusion: 'Darkens creases and corners. Off is faster.',
      shadows: 'The sun and moon shadows over the whole world. Off is much faster.',
      shadowDistance: 'How far from you the sun casts shadows. Shorter is faster.',
      cascades: 'Splits the shadow distance into slices, finer near you. Fewer is faster, but shadows look coarser. Needs a reload.',
      shadowFilter: 'Softness of shadow edges. Lower is faster, edges look rougher. Needs a reload.',
      shadowRefresh: 'How often far shadows are redrawn. Less often is faster and easier on the processor, but far shadows lag behind.',
      antialias: 'Smooths jagged edges. Off is faster. Needs a reload.',
      shadowDetail: 'Sharpness of each shadow slice. Lower is faster. Needs a reload.',
    },
    needsReload: 'Click to reload and apply',
    volume: 'Volume',
    music: 'Music',
    occlusion: 'Occlusion',
    showStats: 'Show stats',
    showGuides: 'Disassembly guides',
    showCounts: 'Steps and parts left',
    copyInvite: 'Copy invite link',
    copied: 'Copied',
    controls: 'Controls',
    minigame: 'Play minigame',
    leave: 'Leave',
    credits: 'credits',
  },
  controls: {
    title: 'Controls',
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
    mouse: (n: number) => `Mouse ${n}`,
    numpad: (key: string) => `Num ${key}`,
  },
  landing: {
    start: 'Start a new game',
    gameOver: 'Game over',
    noSuchWorld: 'No such world',
    copy: 'Copy',
    copied: 'Copied',
    join: 'Join',
    won: 'The desert is yours',
    playOn: 'Play on',
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
  name: { placeholder: 'your name', go: 'Go', skip: 'skip' },

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
    players: (have: number, need: number) => `${have}/${need} players`,
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
    motorcycle: (k: HintKeys) => `Put the motorcycle in the Vehicle slot (${k.inventory}), then press ${k.bike} to ride.`,
    backpack: (k: HintKeys) => `Put the backpack in the Back slot (${k.inventory}).`,
    storm_detector: (k: HintKeys) => `Put the storm detector in the Belt slot (${k.inventory}). It beeps before a storm hits.`,
    wristpad: (k: HintKeys) => `Put the wrist computer in the Wrist slot (${k.inventory}).`,
    shield: (k: HintKeys) => `Put the shield plate in the Armor slot (${k.inventory}). It takes one killing blow for you.`,
    canteen: () => 'With the water bottle on the hotbar, hold the mouse button to drink. Fill it up at a pump.',
    spyglass: () => 'With the telescope on the hotbar, hold the mouse button to look and use the wheel to zoom.',
    laser_pistol: () => 'With the pistol on the hotbar, left mouse fires and right mouse aims.',
    laser_rifle: () => 'With the rifle on the hotbar, left mouse fires and right mouse looks through the scope.',
    jammer: () => 'With the jammer on the hotbar, hold the mouse button on a drone or jet until it comes down.',
    receiver_carrier: () => 'With the receiver on the hotbar, left mouse sends the signal.',
    receiver_queen: () => 'With the receiver on the hotbar, left mouse sends the signal.',
    receiver_colossus: () => 'With the receiver on the hotbar, left mouse sends the signal.',
    receiver_worm: () => 'With the receiver on the hotbar, left mouse sends the signal.',
    plant_bed: () => 'With the plant bed on the hotbar, click to put it down in the bunker.',
    uv_lamp: () => 'Put the UV lamp down over a plant bed.',
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
    boss: 'Oh no. Oh, shit.',
    combat: "Shit, they've seen me. Keep moving!",
    night: "Finally, it's cooling down.",
    bagFull: ["I'm out of room. Something has to go.", "My pockets aren't bottomless."],
    respawn: ["Note to self: don't do that again.", 'Ow. Where was I?', 'Well, that hurt like hell.'],
  },
};

/** Key names a hint can mention, as currently bound. */
export type HintKeys = { inventory: string; bike: string };

/** The shape of the texts: what a translation fills in. */
export type Texts = typeof en;

export const TEXT: Texts = en;
