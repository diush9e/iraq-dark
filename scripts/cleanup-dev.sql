-- Remove smoke-test accounts from local D1 (dev only).
DELETE FROM replies WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'tester%');
DELETE FROM likes WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'tester%');
DELETE FROM bookmarks WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'tester%');
DELETE FROM follows WHERE follower_id IN (SELECT id FROM users WHERE username LIKE 'tester%') OR following_id IN (SELECT id FROM users WHERE username LIKE 'tester%');
DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'tester%') OR actor_id IN (SELECT id FROM users WHERE username LIKE 'tester%');
DELETE FROM topic_views WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'tester%');
DELETE FROM notifications WHERE topic_id IN (SELECT id FROM topics WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'tester%'));
DELETE FROM likes WHERE topic_id IN (SELECT id FROM topics WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'tester%'));
DELETE FROM bookmarks WHERE topic_id IN (SELECT id FROM topics WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'tester%'));
DELETE FROM topic_views WHERE topic_id IN (SELECT id FROM topics WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'tester%'));
DELETE FROM replies WHERE topic_id IN (SELECT id FROM topics WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'tester%'));
DELETE FROM topics WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'tester%');
DELETE FROM user_profiles WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'tester%');
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'tester%');
DELETE FROM users WHERE username LIKE 'tester%';
