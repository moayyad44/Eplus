import common from './common';
import enums from './enums';
import patients from './patients';
import queue from './queue';
import visit from './visit';
import appointments from './appointments';
import lab from './lab';
import billing from './billing';
import dashboard from './dashboard';
import inventory from './inventory';
import staff from './staff';
import reports from './reports';
import settings from './settings';
import system from './system';
import print from './print';
import insurance from './insurance';

export default { ...common, ...enums, ...patients, ...queue, ...visit, ...appointments, ...lab, ...billing, ...dashboard, ...inventory, ...staff, ...reports, ...settings, ...system, ...print, ...insurance };
