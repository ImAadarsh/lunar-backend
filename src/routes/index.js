import { Router } from 'express';
import authRoutes from './auth.routes.js';
import usersRoutes from './users.routes.js';
import sitesRoutes from './sites.routes.js';
import checkpointsRoutes from './checkpoints.routes.js';
import shiftsRoutes from './shifts.routes.js';
import fieldRoutes from './field.routes.js';
import opsRoutes from './ops.routes.js';
import engagementRoutes from './engagement.routes.js';

const api = Router();

api.use('/auth', authRoutes);
api.use('/users', usersRoutes);
api.use('/sites', sitesRoutes);
api.use('/checkpoints', checkpointsRoutes);
api.use('/', shiftsRoutes);
api.use('/', fieldRoutes);
api.use('/', opsRoutes);
api.use('/', engagementRoutes);

export default api;
