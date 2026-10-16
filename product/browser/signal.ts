/** A sculptural voice ribbon. Decorative geometry, never analysis or candidate data. */
export interface SignalOptions { rows?: number; bins?: number; maxHz?: number }
export async function mountSignal(host: HTMLElement, _options: SignalOptions = {}): Promise<void> {
  host.setAttribute('aria-hidden', 'true'); host.classList.add('signal-fallback');
  let cleanup = () => {};
  try {
    const moduleUrl = '/vendor/three.module.js';
    const T: typeof import('three') = await import(moduleUrl);
    if (!host.isConnected) return;
    const renderer = new T.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75)); renderer.setClearColor(0, 0);
    renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.35;
    const scene = new T.Scene(), camera = new T.PerspectiveCamera(33, 1, .1, 60);
    scene.add(new T.HemisphereLight(0xf8f5df, 0x253f39, 3));
    const key = new T.DirectionalLight(0xfff0d6, 5); key.position.set(-3, 5, 5); scene.add(key);
    const rim = new T.DirectionalLight(0x9dcfc2, 4); rim.position.set(4, -1, -2); scene.add(rim);
    const group = new T.Group(); scene.add(group);
    // A continuous folded strip, with a lifted crossing and fine parallel ribs.
    const point = (t: number, v: number) => {
      const x = 2.3 * Math.cos(t), y = 1.08 * Math.sin(2 * t), z = .72 * Math.sin(t);
      const tangent = new T.Vector3(-2.3 * Math.sin(t), 2.16 * Math.cos(2 * t), .72 * Math.cos(t)).normalize();
      const side = new T.Vector3().crossVectors(tangent, new T.Vector3(0, 0, 1)).normalize();
      const normal = new T.Vector3().crossVectors(tangent, side).normalize();
      const twist = .65 * Math.sin(t) + .45;
      return new T.Vector3(x, y, z).addScaledVector(side, v * Math.cos(twist)).addScaledVector(normal, v * Math.sin(twist));
    };
    const positions: number[] = [], indices: number[] = [], segments = 320, across = 16;
    for (let i = 0; i <= segments; i++) for (let j = 0; j <= across; j++) {
      const p = point(i / segments * Math.PI * 2, (j / across - .5) * .85); positions.push(p.x, p.y, p.z);
      if (i < segments && j < across) { const a = i * (across + 1) + j, b = a + across + 1; indices.push(a,b,a+1,b,b+1,a+1); }
    }
    const geometry = new T.BufferGeometry(); geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
    const material = new T.MeshStandardMaterial({color:0x608b76,metalness:.45,roughness:.32,side:T.DoubleSide});
    group.add(new T.Mesh(geometry, material));
    const ribs: InstanceType<typeof T.BufferGeometry>[] = [];
    const ribMaterial = new T.LineBasicMaterial({color:0xdce5c9,transparent:true,opacity:.38});
    for (let j = 0; j <= 28; j++) {
      const points = Array.from({length:321}, (_, i) => point(i/320*Math.PI*2,(j/28-.5)*.855));
      const g = new T.BufferGeometry().setFromPoints(points); ribs.push(g); group.add(new T.Line(g,ribMaterial));
    }
    host.prepend(renderer.domElement); host.classList.add('signal-ready');
    let frame = 0, disposed = false, visible = true, dirty = true, last = 0, px = 0, py = 0;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const resize = () => { const w=host.clientWidth,h=host.clientHeight;if(!w||!h)return;renderer.setSize(w,h);camera.aspect=w/h;camera.position.set(0,0,Math.max(7.6,6.5/camera.aspect));camera.updateProjectionMatrix();dirty=true; };
    const ro = new ResizeObserver(resize); ro.observe(host);
    const io = new IntersectionObserver(e => {visible=e[0]?.isIntersecting??false;dirty=true;}); io.observe(host);
    const move = (e:PointerEvent) => {const r=host.getBoundingClientRect();px=(e.clientX-r.left)/r.width-.5;py=(e.clientY-r.top)/r.height-.5;};
    const leave = () => {px=py=0;}; host.addEventListener('pointermove',move);host.addEventListener('pointerleave',leave);
    const draw = (time:number) => {
      if(disposed)return;if(!host.isConnected){cleanup();return;}frame=requestAnimationFrame(draw);
      if(document.hidden||!visible||time-last<33||(reduced.matches&&!dirty))return;last=time;dirty=false;
      const t=reduced.matches?0:time*.00015;
      group.rotation.z=-.22;group.rotation.y+=( (reduced.matches?.15:.15+Math.sin(t)*.16+px*.38)-group.rotation.y)*.045;
      group.rotation.x+=((reduced.matches?-.12:-.12+py*.25)-group.rotation.x)*.045;
      renderer.render(scene,camera);
    };
    cleanup=()=>{if(disposed)return;disposed=true;cancelAnimationFrame(frame);ro.disconnect();io.disconnect();host.removeEventListener('pointermove',move);host.removeEventListener('pointerleave',leave);window.removeEventListener('pagehide',cleanup);geometry.dispose();ribs.forEach(g=>g.dispose());material.dispose();ribMaterial.dispose();renderer.dispose();renderer.domElement.remove();host.classList.remove('signal-ready');};
    renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();cleanup();});
    window.addEventListener('pagehide',cleanup,{once:true});resize();draw(0);
  } catch {cleanup();}
}
