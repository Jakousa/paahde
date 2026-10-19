// Every text the player sees, in one place (docs/text.md): names of things, prompts, notices, menus, hints and the
// character's speech. Code never writes player-facing words inline; it reads them from TEXT. Shared: the server's
// notices come from here too.
//
// Written in English for now. `Texts` is the shape a translation would fill in: plain strings, and functions where a
// text takes values (so each language can order the words its own way). Keep the voice of docs/text.md: terse
// labels, sentence case, no explanations.

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
    spyglass: 'Hold the mouse button to look, wheel to zoom.',
    canteen: 'Hold the mouse button to drink; fill it at the pump in the base.',
    backpack: 'Bag room past the hotbar.',
    storm_detector: 'Beeps before a sandstorm reaches you.',
    wristpad: 'Shows the clock, the temperature and the locator bar.',
    laser_pistol: 'Left mouse to fire, right mouse to aim.',
    laser_rifle: 'Left mouse to fire, right mouse to look through the scope.',
    jammer: 'Hold the mouse button on a drone or jet until it drops.',
    shield: 'Takes one killing blow, then breaks.',
    receiver: 'Left mouse sends the signal. The needle points to what answers.',
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
    sortTip: 'Pack it tight, biggest first (the hotbar stays)',
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
    death: 'The desert knows no mercy',
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
    display: 'Display',
    fullscreen: 'Fullscreen',
    windowed: 'Windowed',
    fpsTarget: 'FPS target',
    unlimited: 'Unlimited',
    resolution: 'Resolution',
    dynamicRes: 'Adaptive resolution',
    shadows: 'Sun shadows',
    shadowDistance: 'Shadow distance',
    cascades: 'Shadow cascades',
    shadowDetail: 'Shadow detail',
    shadowDetails: ['Low', 'Medium', 'High'],
    tips: {
      display: 'Fullscreen goes fullscreen when you click into the game. Windowed never does.',
      fpsTarget: 'Most frames per second drawn. Lower saves power and heat. Unlimited follows your screen.',
      resolution: 'Draws the game at a lower resolution and stretches it to the window. Lower runs faster on weak PCs.',
      dynamicRes: 'Lowers the resolution when the game runs slower than the FPS target, and raises it again when it can. Unlimited aims at 60.',
      occlusion: 'Darkens creases and corners. Off is faster.',
      shadows: 'The sun and moon shadows over the whole world. Off is much faster.',
      shadowDistance: 'How far from you the sun casts shadows. Shorter is faster.',
      cascades: 'Splits the shadow distance into slices, finer near you. Fewer is faster, but shadows look coarser. Needs a reload.',
      shadowDetail: 'Sharpness of each shadow slice. Lower is faster. Needs a reload.',
    },
    needsReload: 'Applies after a reload',
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
      'The rain stopped. The cities sent their machines out into the sand to find water.',
      'The cities are gone. The machines are still out there, still searching. They kill anything that moves.',
      'A handful of scavengers remain. They strip the wrecks for parts, drink what they can find, and stay out of the sun.',
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
      bolt: 'Spin it: circle the pointer',
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
    motorcycle: (k: HintKeys) => `Motorcycle: ${k.inventory}, into the Vehicle slot. ${k.bike} to ride.`,
    backpack: (k: HintKeys) => `Backpack: ${k.inventory}, into the Back slot.`,
    storm_detector: (k: HintKeys) => `Storm detector: ${k.inventory}, into the Belt slot. Beeps before a storm.`,
    wristpad: (k: HintKeys) => `Wrist computer: ${k.inventory}, into the Wrist slot.`,
    shield: (k: HintKeys) => `Shield plate: ${k.inventory}, into the Armor slot. Takes one killing blow.`,
    canteen: () => 'Water bottle: on the hotbar, hold mouse to drink. Fill at a pump.',
    spyglass: () => 'Telescope: on the hotbar, hold mouse to look, wheel to zoom.',
    laser_pistol: () => 'Laser pistol: on the hotbar. Left mouse fires, right aims.',
    laser_rifle: () => 'Laser rifle: on the hotbar. Left mouse fires, right scopes.',
    jammer: () => 'Jammer: on the hotbar, hold mouse on a drone or jet until it drops.',
    receiver_carrier: () => 'Receiver: on the hotbar. Left mouse sends the signal.',
    receiver_queen: () => 'Receiver: on the hotbar. Left mouse sends the signal.',
    receiver_colossus: () => 'Receiver: on the hotbar. Left mouse sends the signal.',
    receiver_worm: () => 'Receiver: on the hotbar. Left mouse sends the signal.',
    plant_bed: () => 'Plant bed: on the hotbar, click to put it down in the bunker.',
    uv_lamp: () => 'UV lamp: put it down over a plant bed.',
    part: () => 'Parts repair gear on the workbench.',
    broken: () => 'Broken. Repair it at the workbench in the base.',
    machine: () => 'Take it apart at the disassembly table in the base.',
  } as Record<string, (k: HintKeys) => string>,

  // ---- The character talking to themselves (src/speechLines.ts, docs/speech.md); a list: one picked at random -------

  speech: {
    bottleDay: 'This should help me live through this heat...',
    bottleNight: 'This should help me survive out there during the day...',
    machine: 'Full of good parts. Time to open it up.',
    machineCarry: "Too fiddly to strip out here. I'll take it home.",
    /** The first time each kind is in the bag: broken, then working. */
    got: {
      canteen: ["Cracked. I'll need to patch it up first.", 'Water bottle. My new best friend.'],
      motorcycle: ['A bike! Dead, but a bike.', 'Wheels. Finally.'],
      spyglass: ['Cracked lens. Shame, I could see far with this.', 'Now I can see trouble before it sees me.'],
      backpack: ['Torn. Still, more room than my pockets.', 'More room. My back will hate me.'],
      storm_detector: ['Something to hear the storms coming. If it worked.', 'If this beeps, I run.'],
      wristpad: ['A wrist computer. Dead as the desert.', 'A little map of who is where.'],
      shield: ['A plate to hide behind. Bent, though.', 'Something between me and a bad day.'],
      laser_rifle: ['A rifle. Once it works, those walkers had better watch out.', 'Now I can talk back to those walkers.'],
      laser_pistol: ['A pistol. Broken, but a pistol.', 'Small, but it bites.'],
      jammer: ['Some kind of jammer. For the things in the sky?', 'Let them come down to my level.'],
      receiver: ['Some kind of radio. Who would it call?', "Whatever answers this, it won't be small."],
    } as Record<string, [broken: string, working: string]>,
    gotBroken: 'Broken. The right parts might fix it.',
    gotScrap: 'Scrap. Everything out here is made of it.',
    gotCloth: 'Some cloth. Good for patching.',
    gotSpacePart: "That's no ordinary part.",
    gotPart: 'A good part. Something broken will want this.',
    gotPlantBed: 'A garden. In a bunker. Sure.',
    gotUvLamp: 'Sunlight for underground. Ironic.',
    gotRelic: 'Still warm. Somebody will want this back.',
    ride: 'Wind in my face, sand in my teeth.',
    pump: 'There we go.',
    pumpNothing: 'Water, and nothing to carry it in.',
    hot: ['Too hot. I need shade.', "I'm cooking out here.", 'Shade. Any shade.'],
    sip: ['Time for a sip.', 'My throat is sand.'],
    dry: ["Bottle's empty. Need a pump.", 'Not a drop left.'],
    shelter: 'Somebody dug in here once. Nice and cool.',
    /** First time out on a mud flat (shared/biomes.ts), by day and by night. */
    mudflatDay: "A dead lake. The ground's hotter than the air.",
    mudflatNight: "A dead lake. I wouldn't cross this by day.",
    stormWarning: "That beeping can't be good. Better get under a roof.",
    storm: ["Can't see a thing!", 'Sand in my everything.'],
    stormFront: ["That's a wall of sand. I need rock between me and it.", 'Here it comes. Underground, or behind a cliff.'],
    choking: ["Can't breathe out here.", 'Get out of the wind!'],
    lee: 'The rock takes the worst of it.',
    boss: 'Oh. Oh no.',
    combat: "They've seen me. Keep moving!",
    night: 'Finally, it cools down.',
    bagFull: ['No room. Something has to go.', "My pockets aren't bottomless."],
    respawn: ["Note to self: don't do that again.", 'Ow. Where was I?'],
  },
};

/** Key names a hint can mention, as currently bound. */
export type HintKeys = { inventory: string; bike: string };

/** The shape of the texts: what a translation fills in. */
export type Texts = typeof en;

export const TEXT: Texts = en;
