import pino from 'pino'
import { config } from '../config'

export const logger = pino(
  config.nodeEnv === 'development'
    ? {
        level: 'info',
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }
    : {
        level: 'warn',
      }
)
