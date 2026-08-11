const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const BASE_URL = 'http://localhost:3000/api';
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: "postgresql://postgres:postgres@localhost:5432/mindease?schema=public"
    }
  }
});

async function runTests() {
  console.log('==================================================');
  console.log('   INTEGRATION TESTING: PSYCHOLOGIST VALIDATION   ');
  console.log('==================================================');

  try {
    // 1. Register a Psychologist Account
    const psyEmail = `dr.val_${Date.now()}@mindease.com`;
    console.log(`\n[1] Registering psychologist: ${psyEmail}`);
    const regRes = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: psyEmail,
        password: 'securePassword123',
        name: 'Dr. John Doe Val',
        phone: '1234567890',
        role: 'PSYCHOLOGIST',
        acceptedPrivacy: true,
      }),
    });

    const regData = await regRes.json();
    if (regRes.status !== 201) {
      throw new Error(`Registration failed: ${JSON.stringify(regData)}`);
    }

    const psyToken = regData.data.token;
    const psyUserId = regData.data.user.id;
    console.log(`Registered successfully. User ID: ${psyUserId}`);

    // Verify initial status is REGISTRO_INCOMPLETO
    const profRes = await fetch(`${BASE_URL}/psychologists/me`, {
      headers: { Authorization: `Bearer ${psyToken}` },
    });
    const profData = await profRes.json();
    console.log(`Initial Status: ${profData.data.profile.status}`);

    if (profData.data.profile.status !== 'REGISTRO_INCOMPLETO') {
      throw new Error('Initial status should be REGISTRO_INCOMPLETO');
    }

    // 2. Update Professional Attributes
    console.log('\n[2] Updating profile credentials...');
    const updateRes = await fetch(`${BASE_URL}/psychologists/me/profile`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${psyToken}`,
      },
      body: JSON.stringify({
        description: 'Especialista clínico enfocado en resiliencia y manejo emocional.',
        academicBackground: 'Facultad de Psicología, Posgrado en Terapia Cognitiva.',
        experience: '8 años de práctica médica privada.',
        consultationPrice: 700.0,
        location: 'Guadalajara, Jalisco',
        licenseNumber: 'CED-99887766',
        specialties: ['Ansiedad', 'Depresión', 'Estrés Laboral'],
      }),
    });

    const updateData = await updateRes.json();
    console.log(
      `Specialties registered: ${JSON.stringify(
        updateData.data.profile.specialties.map((s) => s.specialty.name)
      )}`
    );

    // 3. Upload Credentials Documents
    console.log('\n[3] Uploading validation documents...');
    const tempFile = path.join(__dirname, 'temp_test_doc.pdf');
    fs.writeFileSync(tempFile, 'PDF MOCK DOCUMENT CONTENT');

    async function uploadDocument(type) {
      const fileData = fs.readFileSync(tempFile);
      const blob = new Blob([fileData], { type: 'application/pdf' });
      const form = new FormData();
      form.append('documentType', type);
      form.append('document', blob, `test_doc_${type.toLowerCase()}.pdf`);

      const uploadRes = await fetch(`${BASE_URL}/psychologists/me/documents`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${psyToken}` },
        body: form,
      });

      return uploadRes.json();
    }

    const idUpload = await uploadDocument('ID');
    console.log(`Uploaded Official ID: ${idUpload.data.document.originalFilename}`);
    const degreeUpload = await uploadDocument('DEGREE');
    console.log(`Uploaded Degree: ${degreeUpload.data.document.originalFilename}`);
    const licenseUpload = await uploadDocument('LICENSE');
    console.log(`Uploaded License Cert: ${licenseUpload.data.document.originalFilename}`);

    fs.unlinkSync(tempFile);

    // 4. Submit for Review
    console.log('\n[4] Submitting for review...');
    const submitRes = await fetch(`${BASE_URL}/psychologists/me/submit-review`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${psyToken}` },
    });

    const submitData = await submitRes.json();
    console.log(`Submission outcome: ${submitData.message}`);

    const statusAfterSubmitRes = await fetch(`${BASE_URL}/psychologists/me/review-status`, {
      headers: { Authorization: `Bearer ${psyToken}` },
    });
    const statusAfterSubmit = await statusAfterSubmitRes.json();
    console.log(`Status after submission: ${statusAfterSubmit.data.currentStatus}`);

    if (statusAfterSubmit.data.currentStatus !== 'PENDIENTE_REVISION') {
      throw new Error('Status should be PENDIENTE_REVISION');
    }

    // 5. Register Admin and Elevate Privileges in DB
    const adminEmail = `admin.val_${Date.now()}@mindease.com`;
    console.log(`\n[5] Creating admin user: ${adminEmail}`);
    const adminRegRes = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: adminEmail,
        password: 'adminPassword123',
        name: 'Administrator Tester',
      }),
    });
    const adminRegData = await adminRegRes.json();
    const adminUserId = adminRegData.data.user.id;

    // Direct database elevation to ADMIN role
    const adminRole = await prisma.role.findUnique({ where: { name: 'ADMIN' } });
    if (!adminRole) throw new Error('ADMIN role not found in database seeding');

    await prisma.userRole.create({
      data: {
        userId: adminUserId,
        roleId: adminRole.id,
      },
    });
    console.log(`Admin account elevated successfully.`);

    // Log in again to get a token with the new elevated role
    const adminLoginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: adminEmail,
        password: 'adminPassword123',
      }),
    });
    const adminLoginData = await adminLoginRes.json();
    if (adminLoginRes.status !== 200) {
      throw new Error(`Admin login failed: ${JSON.stringify(adminLoginData)}`);
    }
    const adminToken = adminLoginData.data.token;
    console.log('Admin logged in and generated fresh token.');

    // 6. Admin Lists Applications
    console.log('\n[6] Admin: Listing pending validation requests...');
    const appsRes = await fetch(`${BASE_URL}/admin/psychologist-applications?status=PENDING`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const appsData = await appsRes.json();
    console.log(`Found ${appsData.data.applications.length} pending verification requests.`);

    const verificationReq = appsData.data.applications.find(
      (app) => app.psychologist.userId === psyUserId
    );
    if (!verificationReq) throw new Error('Could not find the submitted request in list');
    const verificationReqId = verificationReq.id;

    // 7. Admin Assign Revisor
    console.log(`\n[7] Admin: Assigning self to review Request ID: ${verificationReqId}`);
    const assignRes = await fetch(`${BASE_URL}/admin/psychologist-applications/${verificationReqId}/assign`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const assignData = await assignRes.json();
    console.log(`Assignment status: ${assignData.message}`);

    // Check status is now EN_REVISION
    const statusInReviewRes = await fetch(`${BASE_URL}/psychologists/me/review-status`, {
      headers: { Authorization: `Bearer ${psyToken}` },
    });
    const statusInReview = await statusInReviewRes.json();
    console.log(`Psychologist Status is: ${statusInReview.data.currentStatus}`);

    // 8. Admin Request Changes
    console.log('\n[8] Admin: Requesting changes (simulation)...');
    const reqChangesRes = await fetch(
      `${BASE_URL}/admin/psychologist-applications/${verificationReqId}/request-changes`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          notes: 'Por favor vuelve a subir el título profesional. La imagen actual está borrosa.',
        }),
      }
    );
    const reqChangesData = await reqChangesRes.json();
    console.log(`Changes request result: ${reqChangesData.message}`);

    // Verify status is REQUIERE_CAMBIOS
    const statusReqChangesRes = await fetch(`${BASE_URL}/psychologists/me/review-status`, {
      headers: { Authorization: `Bearer ${psyToken}` },
    });
    const statusReqChanges = await statusReqChangesRes.json();
    console.log(`Psychologist Status is: ${statusReqChanges.data.currentStatus}`);
    console.log(`Latest History Log comments: ${statusReqChanges.data.history[0].comment}`);

    // 9. Psychologist Re-submits Review Request
    console.log('\n[9] Psychologist: Submitting review again...');
    const reSubmitRes = await fetch(`${BASE_URL}/psychologists/me/submit-review`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${psyToken}` },
    });
    const reSubmitData = await reSubmitRes.json();
    console.log(`Re-submission outcome: ${reSubmitData.message}`);

    // Fetch the new verification request ID as admin
    const newAppsRes = await fetch(`${BASE_URL}/admin/psychologist-applications?status=PENDING`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const newAppsData = await newAppsRes.json();
    const newReq = newAppsData.data.applications.find((app) => app.psychologist.userId === psyUserId);
    if (!newReq) throw new Error('Could not find re-submitted request');
    const newReqId = newReq.id;

    // 10. Admin Approves Application
    console.log(`\n[10] Admin: Approving Request ID: ${newReqId}...`);
    const approveRes = await fetch(
      `${BASE_URL}/admin/psychologist-applications/${newReqId}/approve`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    const approveData = await approveRes.json();
    console.log(`Approval outcome: ${approveData.message}`);

    // Verify psychologist is now VERIFICADO and has PSYCHOLOGIST_VERIFIED role
    const finalStatusRes = await fetch(`${BASE_URL}/psychologists/me/review-status`, {
      headers: { Authorization: `Bearer ${psyToken}` },
    });
    const finalStatus = await finalStatusRes.json();
    console.log(`Final Psychologist Status: ${finalStatus.data.currentStatus}`);

    // Fetch psychologist profile to see new roles
    const psyProfileRes = await fetch(`${BASE_URL}/users/profile`, {
      headers: { Authorization: `Bearer ${psyToken}` },
    });
    const psyProfileData = await psyProfileRes.json();
    console.log(`User roles updated to: ${JSON.stringify(psyProfileData.data.user.roles)}`);

    if (
      finalStatus.data.currentStatus === 'VERIFICADO' &&
      psyProfileData.data.user.roles.includes('PSYCHOLOGIST_VERIFIED')
    ) {
      console.log('\n==================================================');
      console.log('   INTEGRATION TEST PASSED SUCCESSFULLY (10/10)   ');
      console.log('==================================================');
    } else {
      throw new Error('Status verification failed');
    }
  } catch (error) {
    console.error('\n!!! TEST FAILED !!!');
    console.error(error);
  } finally {
    await prisma.$disconnect();
  }
}

runTests();
