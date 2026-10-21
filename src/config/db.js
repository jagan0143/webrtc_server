import mongoose from 'mongoose';
import { env } from './env.js';

export async function connectDB() {
  mongoose.set('strictQuery', true);
  mongoose.connection.on('disconnected', () => console.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => console.log('MongoDB reconnected'));

  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 10_000 });
  const { host, name } = mongoose.connection;
  console.log(`Mongo connected (${host}/${name})`);
}
