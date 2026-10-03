import type { VehicleSpec } from '../vehicle.ts';

/**
 * VAZ-2106 "Zhiguli" (Lada 1600), 1.6 L carburettor, 4-speed manual, RWD, open diff,
 * front double wishbone, rear live axle on 4 links + Panhard rod.
 *
 * Factory data: curb mass 1045 kg, L/W/H 4166/1611/1440 mm, wheelbase 2424 mm,
 * track F/R 1365/1321 mm, ground clearance 170 mm, tires 165/80 R13,
 * engine 2106: 75 hp @ 5400 rpm, 116 N m @ 3000 rpm, gearbox 3.753/2.303/1.493/1.000, R 3.867,
 * final drive 3.9, top speed 150 km/h, 0-100 km/h ~17 s.
 * Estimated: inertia, suspension rates, damping, brake torques, Cd.
 */
export const VAZ_2106: VehicleSpec = {
  name: 'VAZ-2106',
  // 1045 kg curb + 75 kg driver
  mass: 1120,
  // pitch (about X), yaw (about Y), roll (about Z)
  inertia: { x: 1650, y: 1800, z: 420 },
  cgHeight: 0.55,
  // 53 % on the front axle at static ride
  cgToFrontAxle: 1.14,
  wheelbase: 2.424,
  dimensions: { length: 4.166, width: 1.611, height: 1.44, frontOverhang: 0.78, groundClearance: 0.17 },
  aero: { dragCoefficient: 0.48, frontalArea: 1.82 },

  axles: [
    {
      // Front: independent double wishbone with anti-roll bar.
      track: 1.365,
      springRate: 22000,
      // Spring force at full droop (preload): sprung corner weight 2910 N - 30 kg unsprung
      // = 2616 N at 0.11 m static compression.
      springPreload: 196,
      bumpDamping: 1100,
      reboundDamping: 2300,
      antiRollRate: 9000,
      // Hub travel from full droop to bump-stop contact (m) and static compression.
      travel: 0.19,
      staticCompression: 0.11,
      rollCenterHeight: 0.07,
      brakeTorque: 1250,
      handbrakeTorque: 0,
      maxSteerAngle: 0.56,
      driven: false,
      wheelInertia: 0.85,
      unsprungMass: 30,
    },
    {
      // Rear: live axle. Springs sit inboard (~0.98 m apart) so roll stiffness is lower than
      // the spring rate suggests — modelled as a negative anti-roll rate: k*((0.98/1.321)^2 - 1)/2.
      track: 1.321,
      springRate: 20000,
      // Sprung corner weight 2584 N - 45 kg unsprung = 2143 N at 0.10 m static compression.
      springPreload: 143,
      bumpDamping: 950,
      reboundDamping: 2000,
      antiRollRate: -4500,
      travel: 0.18,
      staticCompression: 0.1,
      rollCenterHeight: 0.33,
      // Drum brakes behind a load-sensing pressure regulator.
      brakeTorque: 550,
      handbrakeTorque: 1100,
      maxSteerAngle: 0,
      driven: true,
      // Includes half-shaft and drum.
      wheelInertia: 1.05,
      // Live axle: half the banjo housing, diff and half-shafts per side.
      unsprungMass: 45,
    },
  ],

  tire: {
    radius: 0.29,
    width: 0.165,
    longStiffness: 19,
    latStiffness: 15,
    relaxLong: 0.18,
    relaxLat: 0.42,
    refLoad: 2800,
    loadSensitivity: 0.15,
    pressure: 200,
    // 165/80 R13 at 2.0 bar: ~180 kN/m radial rate.
    verticalStiffness: 180000,
    verticalDamping: 150,
  },

  engine: {
    idleRpm: 850,
    limiterRpm: 6400,
    stallRpm: 380,
    inertia: 0.16,
    torqueCurve: [
      [0, 0], [500, 60], [1000, 88], [1500, 99], [2000, 106], [2500, 112], [3000, 116], [3500, 115],
      [4000, 113], [4500, 109], [5000, 104], [5400, 98], [6000, 86], [6500, 72], [7000, 50],
    ],
    frictionA: 9,
    frictionB: 0.0042,
    starterTorque: 45,
  },
  transmission: {
    forward: [3.753, 2.303, 1.493, 1.0],
    reverse: 3.867,
    finalDrive: 3.9,
    efficiency: 0.88,
    clutchMaxTorque: 210,
    // A 2106 gearbox has long lever travel; a typical driver needs ~0.45 s per shift.
    shiftTime: 0.45,
  },

  // Body collision points (body-local, m; CG origin, ground at y = -0.55): bumper corners,
  // sills/floor (170 mm clearance), shoulders, roof corners for rollovers.
  hullPoints: [
    [-0.75, -0.25, -1.9], [0.75, -0.25, -1.9], [-0.75, -0.25, 2.2], [0.75, -0.25, 2.2],
    [-0.7, -0.38, -1.0], [0.7, -0.38, -1.0], [-0.7, -0.38, 0.6], [0.7, -0.38, 0.6],
    [0, -0.38, 0.2], [0, -0.38, -0.6],
    [-0.65, 0.85, -0.3], [0.65, 0.85, -0.3], [-0.65, 0.85, 0.9], [0.65, 0.85, 0.9],
    [-0.8, 0.2, -1.4], [0.8, 0.2, -1.4], [-0.8, 0.2, 1.8], [0.8, 0.2, 1.8],
  ],
};
