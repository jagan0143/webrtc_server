import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { verifyToken } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { handleCallDisconnect, registerCallHandlers, userRoom } from './callHandlers.js';
import * as presence from './presence.js';

export function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: env.clientOrigins, credentials: true },
    maxHttpBufferSize: 256 * 1024,
  });

  io.use(async (socket, next) => {
    try {
      const userId = verifyToken(socket.handshake.auth?.token);
      const user = await User.findById(userId).select('name').lean();
      if (!user) return next(new Error('Unauthorized'));
      socket.data.user = { id: String(user._id), name: user.name };
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const { id } = socket.data.user;
    socket.join(userRoom(id));
    if (presence.addSocket(id, socket.id)) {
      socket.broadcast.emit('presence:update', { userId: id, online: true });
    }

    registerCallHandlers(io, socket);

    socket.on('disconnect', () => {
      const wentOffline = presence.removeSocket(id, socket.id);
      handleCallDisconnect(io, socket);
      if (wentOffline) {
        io.emit('presence:update', { userId: id, online: false });
        User.updateOne({ _id: id }, { lastSeen: new Date() }).catch(() => {});
      }
    });
  });

  return io;
}
