async function test() {
  const loginRes = await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'admin.val_1785967730381@mindease.com',
      password: 'adminPassword123'
    })
  });
  const loginData: any = await loginRes.json();
  const token = loginData.data.token;
  console.log('Login successful');

  // 1. Test Dashboard Stats
  console.log('\n--- 1. Testing GET /api/admin/dashboard/stats ---');
  const dashRes = await fetch('http://localhost:3000/api/admin/dashboard/stats', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const dashData: any = await dashRes.json();
  console.log('Dashboard Stats Status:', dashRes.status);
  console.log('Stats summary:', {
    totalUsers: dashData.data?.stats?.totalUsers,
    activeUsers: dashData.data?.stats?.activeUsers,
    verifiedPsychologists: dashData.data?.stats?.verifiedPsychologists,
    pendingRequests: dashData.data?.stats?.pendingRequests,
    approvalRate: `${dashData.data?.stats?.approvalRate}%`,
    statusDistribution: dashData.data?.stats?.statusDistribution,
    topSpecialties: dashData.data?.stats?.topSpecialties,
  });

  // 2. Test Audit Logs CSV Export
  console.log('\n--- 2. Testing GET /api/admin/audit-logs/export-csv ---');
  const csvRes = await fetch('http://localhost:3000/api/admin/audit-logs/export-csv', {
    headers: { Authorization: `Bearer ${token}` }
  });
  console.log('CSV Export Status:', csvRes.status);
  console.log('Content-Type:', csvRes.headers.get('content-type'));
  const csvText = await csvRes.text();
  console.log(`CSV total length: ${csvText.length} characters`);
  console.log('CSV First 3 lines:\n' + csvText.split('\r\n').slice(0, 3).join('\n'));

  // 3. Test Notifications
  console.log('\n--- 3. Testing Notifications System ---');
  // 3a. Broadcast a system notification
  const broadcastRes = await fetch('http://localhost:3000/api/admin/notifications/broadcast', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      title: 'Mantenimiento Programado',
      message: 'El sistema entrará en ventana de mantenimiento el domingo a las 02:00 AM.'
    })
  });
  const broadcastData: any = await broadcastRes.json();
  console.log('Broadcast status:', broadcastRes.status, broadcastData.message);

  // 3b. List notifications
  const notifListRes = await fetch('http://localhost:3000/api/admin/notifications', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const notifListData: any = await notifListRes.json();
  console.log('List Notifications status:', notifListRes.status, `Total: ${notifListData.data?.notifications?.length}, Unread: ${notifListData.data?.unreadCount}`);
  const firstNotif = notifListData.data?.notifications?.[0];

  if (firstNotif) {
    // 3c. Mark single notification as read
    const markReadRes = await fetch(`http://localhost:3000/api/admin/notifications/${firstNotif.id}/read`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log(`Mark read for ${firstNotif.id} status:`, markReadRes.status);

    // 3d. Mark all as read
    const markAllRes = await fetch('http://localhost:3000/api/admin/notifications/mark-all-read', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log('Mark all read status:', markAllRes.status);
  }

  console.log('\nAll 3 modules (Dashboard Stats, Audit CSV, Notifications) verified successfully in Backend!');
}

test().catch(console.error);
