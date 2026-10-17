# Procedural (Cycles) materials for the generators. They are only used for baking: every input that the
# bake reads (Base Color / Roughness / Metallic / Normal) is a node graph built from object-space and
# 'Detail'-UV noise, plus Cycles-only cavity terms (AO node, Pointiness) for dirt and edge wear.
from sclib import NB, new_mat, srgb


def _dust(nb, col, o, amount=1.0, dust_hex='#b3804f', height=0.75):
    """Orange desert dust: settles low (kicked up from the sand) and on up-facing surfaces."""
    z = nb.sep(o)['Z']
    low = nb.mr(z, height, 0.0, 0.0, 1.0, smooth=True)
    up = nb.mr(nb.sep(nb.geo('Normal'))['Z'], 0.2, 1.0, 0.0, 0.55)
    patch = nb.noise(o, scale=7.0, detail=6.0, rough=0.65)
    patch = nb.mr(patch, 0.35, 0.7, 0.35, 1.0)
    fac = nb.mul(nb.math('MAXIMUM', low, up), patch)
    fac = nb.mul(fac, amount)
    return nb.mix(fac, col, srgb(dust_hex)), fac


def _grime(nb, col, amount=0.7, distance=0.06, hex_='#1e140c'):
    ao = nb.ao(distance=distance, samples=16)
    cav = nb.mr(ao, 0.15, 1.0, 1.0, 0.0)
    return nb.mix(nb.mul(cav, amount), col, srgb(hex_), blend='MULTIPLY'), cav


def cloth(name, base, dark, dust=1.0, rough=0.92, weave=0.45, wrinkle=0.5, stains=0.5, bleach='#d8c6a6',
          bleach_amt=0.35):
    m = new_mat(name)
    nb = NB(m)
    uv, o = nb.uv(), nb.obj()
    # large-scale mottling between two dyes (uneven fading)
    mott = nb.noise(o, scale=3.0, detail=6.0, rough=0.6)
    col = nb.mix(nb.mr(mott, 0.3, 0.72), srgb(dark), srgb(base))
    # sun-bleached streaks running along the cloth (Detail v), stronger up high
    streak = nb.noise(nb.mapping(uv, scale=(9.0, 0.7, 1.0)), scale=2.0, detail=3.0)
    col = nb.mix(nb.mul(nb.mr(streak, 0.45, 0.8), bleach_amt), col, srgb(bleach))
    # threads / slub (stretched noise in both directions → coarse homespun weave)
    tu = nb.noise(nb.mapping(uv, scale=(260.0, 14.0, 1.0)), scale=1.0, detail=2.0)
    tv = nb.noise(nb.mapping(uv, scale=(14.0, 260.0, 1.0)), scale=1.0, detail=2.0)
    threads = nb.mul(nb.add(tu, tv), 0.5)
    col = nb.mix(nb.mr(threads, 0.3, 0.7, 0.0, 0.18), col, srgb('#000000'), blend='MULTIPLY')
    # stains (sweat, oil, old dye)
    st = nb.noise(o, scale=5.0, detail=8.0, rough=0.7, distortion=0.4)
    col = nb.mix(nb.mul(nb.mr(st, 0.56, 0.68), stains), col, srgb('#2a1c12'), blend='MULTIPLY')
    col, cav = _grime(nb, col, 0.45, 0.035)
    col, dfac = _dust(nb, col, o, dust)
    r = nb.add(rough, nb.mul(nb.mr(threads, 0.3, 0.7, -0.04, 0.04), 1.0), nb.mul(dfac, 0.06))
    # creases: ridged noise stretched across the cloth
    cr = nb.noise(nb.mapping(uv, scale=(1.4, 5.0, 1.0)), scale=3.0, detail=4.0, rough=0.55, distortion=0.6)
    ridge = nb.math('ABSOLUTE', nb.math('SUBTRACT', cr, 0.5))
    ridge = nb.mr(ridge, 0.0, 0.18, 1.0, 0.0)
    h = nb.add(nb.mul(threads, weave), nb.mul(ridge, wrinkle))
    nrm = nb.bump(h, strength=0.45, distance=0.004)
    nb.principled(col, r, 0.0, nrm)
    return m


def leather(name, base, dark, scuff='#8a6a4c', rough=0.55, dust=0.8):
    m = new_mat(name)
    nb = NB(m)
    o = nb.obj()
    mott = nb.noise(o, scale=9.0, detail=5.0, rough=0.6)
    col = nb.mix(nb.mr(mott, 0.3, 0.7), srgb(dark), srgb(base))
    # fine grain
    grain = nb.voronoi(o, scale=420.0, feature='DISTANCE_TO_EDGE', out='Distance')
    # creases
    cr = nb.noise(o, scale=40.0, detail=3.0, distortion=0.8)
    ridge = nb.mr(nb.math('ABSOLUTE', nb.math('SUBTRACT', cr, 0.5)), 0.0, 0.08, 1.0, 0.0)
    # scuffs on convex edges
    edge = nb.mr(nb.geo('Pointiness'), 0.5, 0.56, 0.0, 1.0)
    sn = nb.noise(o, scale=60.0, detail=4.0)
    scuffs = nb.mul(edge, nb.mr(sn, 0.4, 0.6, 0.2, 1.0))
    col = nb.mix(nb.mul(scuffs, 0.8), col, srgb(scuff))
    col = nb.mix(nb.mul(ridge, 0.35), col, srgb(dark), blend='MULTIPLY')
    col, cav = _grime(nb, col, 0.8, 0.05)
    col, dfac = _dust(nb, col, o, dust, height=0.45)
    r = nb.add(rough, nb.mul(scuffs, 0.2), nb.mul(dfac, 0.25), nb.mr(mott, 0, 1, -0.08, 0.08))
    h = nb.add(nb.mr(grain, 0.0, 0.08, 0.0, 0.25), nb.mul(ridge, 0.6))
    nrm = nb.bump(h, strength=0.35, distance=0.003)
    nb.principled(col, r, 0.0, nrm)
    return m


def metal(name, base, patina, rough=0.38, dust=0.6, dirt=0.8, metallic=1.0, scratches=0.5, paint=None):
    """Brass / steel. `paint`: optional chipped paint colour over the metal."""
    m = new_mat(name)
    nb = NB(m)
    o = nb.obj()
    n1 = nb.noise(o, scale=14.0, detail=6.0, rough=0.6)
    col = nb.mix(nb.mr(n1, 0.45, 0.75, 0.0, 0.7), srgb(base), srgb(patina))
    ao = nb.ao(distance=0.03, samples=16)
    cav = nb.mr(ao, 0.3, 1.0, 1.0, 0.0)
    col = nb.mix(nb.mul(cav, 0.8), col, srgb(patina))
    edge = nb.mr(nb.geo('Pointiness'), 0.5, 0.56, 0.0, 1.0)
    # scratches: thin stretched noise lines
    sc = nb.noise(nb.mapping(o, scale=(400.0, 20.0, 20.0), rot=(0.3, 0.7, 0.2)), scale=1.0, detail=1.0)
    scr = nb.mul(nb.mr(sc, 0.62, 0.7), scratches)
    metal_mask = nb.mixf(cav, metallic, metallic * 0.4)
    if paint:
        chips = nb.noise(o, scale=22.0, detail=8.0, rough=0.7)
        painted = nb.mr(nb.add(chips, nb.mul(edge, -0.5)), 0.42, 0.5, 0.0, 1.0)
        col = nb.mix(painted, col, srgb(paint))
        metal_mask = nb.mixf(painted, metal_mask, 0.0)
    bright = nb.add(nb.mul(edge, 0.6), scr)
    col = nb.mix(nb.math('MINIMUM', bright, 1.0), col, srgb(base), blend='LIGHTEN')
    col = nb.mix(nb.mul(cav, dirt), col, srgb('#24180f'), blend='MULTIPLY')
    col, dfac = _dust(nb, col, o, dust, height=0.5)
    metal_mask = nb.mixf(dfac, metal_mask, 0.0)
    r = nb.add(rough, nb.mr(n1, 0.0, 1.0, -0.1, 0.15), nb.mul(cav, 0.25), nb.mul(edge, -0.15), nb.mul(dfac, 0.5))
    if paint:
        r = nb.mixf(painted, r, 0.7)
    h = nb.add(nb.mul(nb.noise(o, scale=90.0, detail=2.0), 0.15), nb.mul(scr, -0.4))
    nrm = nb.bump(h, strength=0.25, distance=0.002)
    nb.principled(col, r, metal_mask, nrm)
    return m


def plain(name, base, rough=0.8, dust=0.6):
    """Rubber / hard plastic."""
    m = new_mat(name)
    nb = NB(m)
    o = nb.obj()
    n1 = nb.noise(o, scale=12.0, detail=4.0)
    col = nb.mix(nb.mr(n1, 0.3, 0.7, 0.0, 0.25), srgb(base), srgb('#000000'), blend='MULTIPLY')
    col, cav = _grime(nb, col, 0.6, 0.04)
    col, dfac = _dust(nb, col, o, dust, height=0.4)
    r = nb.add(rough, nb.mul(dfac, 0.15))
    nrm = nb.bump(nb.noise(o, scale=150.0, detail=2.0), strength=0.2, distance=0.002)
    nb.principled(col, r, 0.0, nrm)
    return m


def wood(name, base='#6b4a2e', dark='#3a2617'):
    m = new_mat(name)
    nb = NB(m)
    uv, o = nb.uv(), nb.obj()
    g = nb.wave(nb.mapping(uv, scale=(1.0, 0.08, 1.0)), scale=30.0, direction='X', distortion=6.0, detail=4.0,
                profile='SAW')
    col = nb.mix(nb.mr(g, 0.0, 1.0), srgb(base), srgb(dark))
    col, cav = _grime(nb, col, 0.8, 0.03)
    # hand-polished grip darkening
    col, dfac = _dust(nb, col, o, 0.6)
    r = nb.add(0.6, nb.mul(g, 0.15))
    nrm = nb.bump(g, strength=0.15, distance=0.002)
    nb.principled(col, r, 0.0, nrm)
    return m


def lens(name='Lens', glow='#ffae42', strength=3.0):
    """Unbaked: faint glowing goggle lens / vacuum tube glass."""
    m = new_mat(name)
    nb = NB(m)
    nb.principled(srgb('#1a0f06'), 0.08, 0.0, None, emission=srgb(glow), emission_strength=strength)
    return m
