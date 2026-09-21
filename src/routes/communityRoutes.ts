import { Router } from 'express';
import { authMiddleware, optionalAuthMiddleware } from '../middlewares/authMiddleware';
import { communityUpload } from '../middlewares/uploadMiddleware';
import {
  getCategories,
  getChannels,
  getChannelById,
  createChannel,
  updateChannel,
  toggleFollowChannel,
} from '../controllers/channelController';
import {
  uploadPostMedia,
  createPost,
  getPosts,
  getPostById,
  updatePost,
  deletePost,
  toggleLikePost,
  getComments,
  addComment,
  deleteComment,
} from '../controllers/postController';
import {
  createReport,
  getReports,
  reviewReport,
  moderatePost,
  moderateComment,
} from '../controllers/reportController';

const router = Router();

// ========================
// CATEGORIES & CHANNELS
// ========================
router.get('/categories', optionalAuthMiddleware, getCategories);
router.get('/channels', optionalAuthMiddleware, getChannels);
router.get('/channels/:id', optionalAuthMiddleware, getChannelById);
router.post('/channels', authMiddleware, createChannel);
router.put('/channels/:id', authMiddleware, updateChannel);
router.post('/channels/:id/follow', authMiddleware, toggleFollowChannel);

// ========================
// MEDIA UPLOAD
// ========================
router.post('/upload', authMiddleware, communityUpload.single('file'), uploadPostMedia);

// ========================
// POSTS (PUBLICATIONS)
// ========================
router.get('/posts', optionalAuthMiddleware, getPosts);
router.get('/posts/:id', optionalAuthMiddleware, getPostById);
router.post('/posts', authMiddleware, createPost);
router.put('/posts/:id', authMiddleware, updatePost);
router.delete('/posts/:id', authMiddleware, deletePost);

// ========================
// INTERACTIONS (LIKES & COMMENTS)
// ========================
router.post('/posts/:id/like', authMiddleware, toggleLikePost);
router.get('/posts/:id/comments', optionalAuthMiddleware, getComments);
router.post('/posts/:id/comments', authMiddleware, addComment);
router.delete('/comments/:commentId', authMiddleware, deleteComment);

// ========================
// REPORTS & MODERATION
// ========================
router.post('/reports', authMiddleware, createReport);
router.get('/reports', authMiddleware, getReports);
router.put('/reports/:id/review', authMiddleware, reviewReport);
router.put('/posts/:id/moderate', authMiddleware, moderatePost);
router.put('/comments/:id/moderate', authMiddleware, moderateComment);

export default router;
