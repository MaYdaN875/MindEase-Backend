import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import prisma from '../config/db';
import { hashPassword, comparePassword } from '../utils/hash';
import { generateToken } from '../utils/jwt';
import { AppError } from '../middlewares/errorMiddleware';

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters long'),
  name: z.string().min(2, 'Name must be at least 2 characters long'),
  role: z.enum(['USER', 'PSYCHOLOGIST', 'ADMIN']).optional(),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  password: z.string().min(6, 'Password must be at least 6 characters long'),
});

export const register = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const validated = registerSchema.parse(req.body);

    const existingUser = await prisma.user.findUnique({
      where: { email: validated.email.toLowerCase() },
    });

    if (existingUser) {
      throw new AppError('Email already registered', 400);
    }

    const passwordHash = await hashPassword(validated.password);

    const user = await prisma.user.create({
      data: {
        email: validated.email.toLowerCase(),
        passwordHash,
        name: validated.name,
        role: validated.role || 'USER',
      },
    });

    const token = generateToken({ userId: user.id, role: user.role });

    res.status(201).json({
      status: 'success',
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          createdAt: user.createdAt,
        },
        token,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(error.errors[0].message, 400));
    }
    next(error);
  }
};

export const login = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const validated = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { email: validated.email.toLowerCase() },
    });

    if (!user || !(await comparePassword(validated.password, user.passwordHash))) {
      throw new AppError('Incorrect email or password', 401);
    }

    const token = generateToken({ userId: user.id, role: user.role });

    res.status(200).json({
      status: 'success',
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        },
        token,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(error.errors[0].message, 400));
    }
    next(error);
  }
};

export const forgotPassword = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const validated = forgotPasswordSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { email: validated.email.toLowerCase() },
    });

    if (!user) {
      res.status(200).json({
        status: 'success',
        message: 'If the email matches a registered account, a password reset link has been sent.',
      });
      return;
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetPasswordExp = new Date(Date.now() + 3600000); // 1 hour expiration

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetPasswordToken: resetToken,
        resetPasswordExp,
      },
    });

    // Simulate email dispatch
    console.log(`\n==========================================`);
    console.log(`PASSWORD RESET FOR: ${user.email}`);
    console.log(`Token: ${resetToken}`);
    console.log(`Reset link: http://localhost:3000/api/auth/reset-password?token=${resetToken}`);
    console.log(`==========================================\n`);

    res.status(200).json({
      status: 'success',
      message: 'If the email matches a registered account, a password reset link has been sent.',
      ...(process.env.NODE_ENV !== 'production' && { debugToken: resetToken }),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(error.errors[0].message, 400));
    }
    next(error);
  }
};

export const resetPassword = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const validated = resetPasswordSchema.parse(req.body);

    const user = await prisma.user.findFirst({
      where: {
        resetPasswordToken: validated.token,
        resetPasswordExp: {
          gt: new Date(),
        },
      },
    });

    if (!user) {
      throw new AppError('Token is invalid or has expired', 400);
    }

    const passwordHash = await hashPassword(validated.password);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        resetPasswordToken: null,
        resetPasswordExp: null,
      },
    });

    res.status(200).json({
      status: 'success',
      message: 'Password reset successful. You can now login with your new password.',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(error.errors[0].message, 400));
    }
    next(error);
  }
};
