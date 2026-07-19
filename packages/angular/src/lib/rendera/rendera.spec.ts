import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Rendera } from './rendera';

describe('Rendera', () => {
  let component: Rendera;
  let fixture: ComponentFixture<Rendera>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Rendera],
    }).compileComponents();

    fixture = TestBed.createComponent(Rendera);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
