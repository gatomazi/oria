'use strict';

// Fatia 3 dos negative controls (ver test/helpers/negative-controls-nucleo.cjs). O ciclo de 5 passos
// é o mesmo de sempre; só a fração das violações que este arquivo roda muda.

const { registrarFatia } = require('../helpers/negative-controls-nucleo.cjs');

registrarFatia(3);
