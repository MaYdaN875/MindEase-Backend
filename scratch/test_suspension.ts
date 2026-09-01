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

  const usersRes = await fetch('http://localhost:3000/api/admin/users', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const usersData: any = await usersRes.json();
  const targetUser = usersData.data.users.find((u: any) => u.email === 'angelleon0100@gmail.com');
  console.log('Target user found:', targetUser?.name, 'User status:', targetUser?.status, 'Psychologist status:', targetUser?.psychologistProfile?.status);

  // Reactivate user
  console.log('\nReactivating target user with status: ACTIVE...');
  const reactivateRes = await fetch(`http://localhost:3000/api/admin/users/${targetUser.id}/status`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ status: 'ACTIVE' })
  });
  const reactivateData: any = await reactivateRes.json();
  console.log('Reactivate response:', reactivateRes.status, reactivateData);

  const usersRes2 = await fetch('http://localhost:3000/api/admin/users', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const usersData2: any = await usersRes2.json();
  const targetUser2 = usersData2.data.users.find((u: any) => u.email === 'angelleon0100@gmail.com');
  console.log('Target user after reactivation -> User status:', targetUser2?.status, 'Psychologist status:', targetUser2?.psychologistProfile?.status);
}

test().catch(console.error);
