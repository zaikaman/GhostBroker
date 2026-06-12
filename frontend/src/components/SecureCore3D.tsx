import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

export function SecureCore3D(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // --- Scene, Camera, Renderer Setup ---
    const scene = new THREE.Scene();

    // Use container dimensions
    const width = container.clientWidth || 500;
    const height = container.clientHeight || 500;
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.z = 8;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    // --- Lighting ---
    const ambientLight = new THREE.AmbientLight(0x0f172a, 1.5);
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 2.5);
    dirLight1.position.set(5, 5, 5);
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0xc5a880, 2.0); // Gold accent light
    dirLight2.position.set(-5, -5, 3);
    scene.add(dirLight2);

    const pointLight = new THREE.PointLight(0xfbbf24, 3, 10); // Glowing amber core light
    pointLight.position.set(0, 0, 0);
    scene.add(pointLight);

    // --- Core 3D Group ---
    const coreGroup = new THREE.Group();
    scene.add(coreGroup);

    // --- Materials ---
    // Luxury gold metal
    const goldMaterial = new THREE.MeshStandardMaterial({
      color: 0xc5a880,
      metalness: 0.9,
      roughness: 0.1,
      envMapIntensity: 1.0,
    });

    // Dark translucent glass
    const glassMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x161d2f,
      metalness: 0.2,
      roughness: 0.1,
      transparent: true,
      opacity: 0.35,
      transmission: 0.6,
      thickness: 1.2,
      depthWrite: false,
    });

    // Glowing amber core
    const coreMaterial = new THREE.MeshStandardMaterial({
      color: 0xc5a880,
      emissive: 0xfbbf24,
      emissiveIntensity: 1.5,
      metalness: 0.9,
      roughness: 0.1,
    });

    // --- 1. Outer Glass Cube ---
    const outerSize = 2.4;
    const outerGeo = new THREE.BoxGeometry(outerSize, outerSize, outerSize);
    const outerMesh = new THREE.Mesh(outerGeo, glassMaterial);
    coreGroup.add(outerMesh);

    // Outer Cube Gold Edges
    const outerEdgesGeo = new THREE.EdgesGeometry(outerGeo);
    const outerEdgesMat = new THREE.LineBasicMaterial({ color: 0xc5a880, linewidth: 2 });
    const outerEdges = new THREE.LineSegments(outerEdgesGeo, outerEdgesMat);
    coreGroup.add(outerEdges);

    // --- 2. Inner Glowing Cube ---
    const innerSize = 1.0;
    const innerGeo = new THREE.BoxGeometry(innerSize, innerSize, innerSize);
    const innerMesh = new THREE.Mesh(innerGeo, coreMaterial);
    coreGroup.add(innerMesh);

    const innerEdgesGeo = new THREE.EdgesGeometry(innerGeo);
    const innerEdgesMat = new THREE.LineBasicMaterial({ color: 0xfbbf24, linewidth: 1 });
    const innerEdges = new THREE.LineSegments(innerEdgesGeo, innerEdgesMat);
    coreGroup.add(innerEdges);

    // --- 3. Hypercube Tesseract Vertex Connections ---
    // Define 8 vertex offsets for unit cube
    const vertices = [
      new THREE.Vector3(-1, -1, -1),
      new THREE.Vector3(1, -1, -1),
      new THREE.Vector3(1, 1, -1),
      new THREE.Vector3(-1, 1, -1),
      new THREE.Vector3(-1, -1, 1),
      new THREE.Vector3(1, -1, 1),
      new THREE.Vector3(1, 1, 1),
      new THREE.Vector3(-1, 1, 1),
    ];

    const connectionGroup = new THREE.Group();
    coreGroup.add(connectionGroup);

    const connectionRadius = 0.035;

    function createCylinderConnection(pA: THREE.Vector3, pB: THREE.Vector3) {
      const direction = new THREE.Vector3().subVectors(pB, pA);
      const length = direction.length();
      const geometry = new THREE.CylinderGeometry(connectionRadius, connectionRadius, length, 8);
      const mesh = new THREE.Mesh(geometry, goldMaterial);

      const position = new THREE.Vector3().addVectors(pA, pB).multiplyScalar(0.5);
      mesh.position.copy(position);

      const up = new THREE.Vector3(0, 1, 0);
      direction.normalize();
      mesh.quaternion.setFromUnitVectors(up, direction);
      connectionGroup.add(mesh);
    }

    // Connect corresponding inner and outer vertices
    vertices.forEach((v) => {
      const pOuter = v.clone().multiplyScalar(outerSize / 2);
      const pInner = v.clone().multiplyScalar(innerSize / 2);
      createCylinderConnection(pOuter, pInner);
    });

    // --- 4. Rotating Cryptographic Rings ---
    const ringGroup = new THREE.Group();
    scene.add(ringGroup);

    const ringMat1 = new THREE.MeshStandardMaterial({
      color: 0xc5a880,
      emissive: 0xc5a880,
      emissiveIntensity: 0.6,
      side: THREE.DoubleSide,
    });

    const ringGeo1 = new THREE.TorusGeometry(2.0, 0.02, 8, 100);
    const ring1 = new THREE.Mesh(ringGeo1, ringMat1);
    ring1.rotation.x = Math.PI / 3;
    ringGroup.add(ring1);

    const ringGeo2 = new THREE.TorusGeometry(2.3, 0.015, 8, 100);
    const ring2 = new THREE.Mesh(ringGeo2, ringMat1);
    ring2.rotation.y = Math.PI / 4;
    ringGroup.add(ring2);

    // --- 5. Orbiting Data Particles ---
    const particleCount = 24;
    const particles: { mesh: THREE.Mesh; angle: number; speed: number; radiusX: number; radiusY: number; planeRotation: number }[] = [];
    const particleMat = new THREE.MeshBasicMaterial({ color: 0x34d399 }); // Emerald Green

    for (let i = 0; i < particleCount; i++) {
      const particleGeo = new THREE.SphereGeometry(0.04, 8, 8);
      const pMesh = new THREE.Mesh(particleGeo, particleMat);
      scene.add(pMesh);

      particles.push({
        mesh: pMesh,
        angle: Math.random() * Math.PI * 2,
        speed: 0.01 + Math.random() * 0.015,
        radiusX: 2.2 + Math.random() * 0.6,
        radiusY: 1.8 + Math.random() * 0.5,
        planeRotation: Math.random() * Math.PI * 2,
      });
    }

    // --- Mouse Interaction Telemetry ---
    let targetRotationX = 0;
    let targetRotationY = 0;
    let mouseX = 0;
    let mouseY = 0;

    const handleMouseMove = (event: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      // Normalized coordinates: -1 to 1
      mouseX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouseY = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      targetRotationY = mouseX * 0.5;
      targetRotationX = -mouseY * 0.5;
    };

    container.addEventListener('mousemove', handleMouseMove);

    // --- Animation Loop ---
    let animationFrameId: number;

    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);

      // Auto-spin base
      coreGroup.rotation.y += 0.006;
      coreGroup.rotation.x += 0.003;

      // Orbit rings spin
      ringGroup.rotation.z -= 0.004;
      ringGroup.rotation.x += 0.001;

      // Lerp rotation based on mouse hover
      coreGroup.rotation.y += (targetRotationY - coreGroup.rotation.y) * 0.05;
      coreGroup.rotation.x += (targetRotationX - coreGroup.rotation.x) * 0.05;

      // Update orbiting particles
      particles.forEach((p) => {
        p.angle += p.speed;
        // Basic elliptical orbit math
        const localX = Math.cos(p.angle) * p.radiusX;
        const localY = Math.sin(p.angle) * p.radiusY;

        // Rotate orbit plane to make it 3D
        p.mesh.position.x = localX * Math.cos(p.planeRotation);
        p.mesh.position.y = localY;
        p.mesh.position.z = localX * Math.sin(p.planeRotation);
      });

      renderer.render(scene, camera);
    };

    animate();

    // --- Resize Handler ---
    const handleResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };

    window.addEventListener('resize', handleResize);

    // --- Cleanup ---
    return () => {
      cancelAnimationFrame(animationFrameId);
      container.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('resize', handleResize);

      // Recursive cleanup
      scene.clear();
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div 
      ref={containerRef} 
      style={{ 
        width: '100%', 
        height: '100%', 
        position: 'relative', 
        overflow: 'hidden',
        cursor: 'grab' 
      }} 
    />
  );
}
